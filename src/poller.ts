import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { isCredentialRejection, recordCredentialRejection } from "./credentials.js";
import { saveCollection } from "./events/pipeline.js";
import type { Collection } from "./events/types.js";
import { classifyFailure, type Diagnosis } from "./failureDiagnosis.js";
import { log } from "./logger.js";
import { lockHolder, withActionLock } from "./runtime/actionLock.js";
import { measure } from "./runtime/metricRecording.js";
import { SourceHttpError } from "./sources/http.js";
import { type SourceDefinition, sourceJobs } from "./sources/registry.js";
import { collectInSubprocess } from "./sources/subprocess.js";
import { addCollectionToDay, addPeakToDay } from "./storage/collectionDays.js";
import { recordFailureEvidence } from "./storage/failureEvidence.js";
import { recordSourceShape } from "./storage/sourceShapes.js";
import { writeTransaction } from "./storage/transaction.js";
import { rememberStoryProjection } from "./stories.js";

const MAX_CONCURRENT_SOURCES = 4;

/**
 * Each consecutive failure doubles the wait, up to eight times the normal interval. A source that
 * is refusing us recovers on its own schedule, and asking every two minutes in the meantime is how
 * a refusal turns into a block — which is exactly what happened when a status page's bot
 * protection started answering with a CAPTCHA.
 *
 * Doubling an interval that is already long puts the source out for days. The image-editing arena
 * is read once a day; its connection dropped on 2026-09-22, and the doubling meant the next attempt
 * was two days later and the one after that four, so a blink of the link became a board that stayed
 * red for most of a week. The extra wait is therefore bounded: the backoff is what stops us asking
 * a refusing host every two minutes, not a reason to stop asking a daily source until Friday. A
 * frequent source keeps the behaviour it had, since eight times fifteen minutes is inside the
 * ceiling anyway.
 */
const MAX_BACKOFF_SECONDS = 6 * 3_600;

export function due(checkedAt: string | null, interval: number, failures: number, now = Date.now()): boolean {
  if (!checkedAt) return true;
  const backedOff = Math.min(interval * Math.min(2 ** failures, 8), interval + MAX_BACKOFF_SECONDS);
  return now - Date.parse(checkedAt) >= backedOff * 1000;
}

export type PollOutcome = { collected: boolean; sources: number; heldBy?: string };

/**
 * One collection cycle at a time, whoever asked for it. The service polls on a timer and the
 * operator polls from the CLI while investigating a source; those are two processes against one
 * database file, and a source collected twice in the same second writes evidence that disagrees
 * with itself. The lease lives in the database because that is the only thing both of them share.
 *
 * Two minutes, renewed while the cycle runs: a live cycle holds the lock for as long as it needs,
 * and a killed one blocks the next process for two minutes rather than for longer than it takes
 * the sources it never reached to be reported stale.
 */
const COLLECTION_LEASE_MS = 2 * 60_000;

/**
 * One named source, collected now, under the same lock a whole cycle takes.
 *
 * For a source being investigated. `poll` forces all of them, which is two hundred requests to
 * answer a question about one, and a paced source can still be skipped by the group's slot -- so
 * the narrow version takes no slot and spends no other source's.
 *
 * It does wait out a `Retry-After` the server set for itself, as a forced cycle does: asking early
 * is what earned it, and spending an operator's command on a request that is already refused
 * answers nothing.
 */
export async function collectNamedSource(
  db: Database,
  config: AppConfig,
  source: string,
): Promise<SourceOutcome | { source: string; status: "deferred"; retryAt: string } | { heldBy: string }> {
  const job = sourceJobs(db, config).find((definition) => definition.id === source);
  if (!job) throw new Error(`${source} is not a source this deployment collects`);
  const retryAt = db
    .query<{ retry_at: string | null }, [string]>("SELECT retry_at FROM sources WHERE id=?")
    .get(source)?.retry_at;
  if (retryAt && Date.parse(retryAt) > Date.now()) return { source, status: "deferred", retryAt };
  const outcome = await withActionLock(db, "collection", lockHolder("collect-one"), COLLECTION_LEASE_MS, () =>
    collectSource(db, config, job),
  );
  if (outcome.acquired) return outcome.result;
  log("info", "Collection skipped", { source, heldBy: outcome.heldBy.holder });
  return { heldBy: outcome.heldBy.holder };
}

export async function pollSources(db: Database, config: AppConfig, force = false): Promise<PollOutcome> {
  const outcome = await withActionLock(db, "collection", lockHolder("poller"), COLLECTION_LEASE_MS, ({ signal }) =>
    collectDueSources(db, config, force, signal),
  );
  if (outcome.acquired) return { collected: true, sources: outcome.result };
  log("info", "Collection cycle skipped", { heldBy: outcome.heldBy.holder });
  return { collected: false, sources: 0, heldBy: outcome.heldBy.holder };
}

/**
 * The job that has gone longest without an answer takes a paced group's turn.
 *
 * A pace group is one slot per cycle, and it used to go to whoever stood earliest in the source
 * registry. Thirty Hugging Face authors share `huggingface.co`, so the labs at the front took every
 * slot and the tail was never collected at all: on 2026-09-24 five authors had not been read since
 * the 22nd and two had never been read once, with no error on any of them and nothing anywhere
 * that said so. Waiting longest is the only fair claim on a slot, and a source that has never been
 * collected has waited longest of all.
 */
export function byLongestWait(
  jobs: readonly SourceDefinition[],
  checkedAt: (id: string) => string | null,
  now = Date.now(),
): SourceDefinition[] {
  const waited = (job: SourceDefinition): number => {
    const at = checkedAt(job.id);
    return at ? now - Date.parse(at) : Number.POSITIVE_INFINITY;
  };
  return [...jobs].sort((a, b) => waited(b) - waited(a));
}

/**
 * A source whose cheap upstream question answered "nothing new": marked checked and successful
 * without collecting anything, and the instant it was marked at. Null when there was no cheap
 * question to ask or the answer was that something moved.
 *
 * Successful, not merely checked: being told by upstream that nothing has changed is a source
 * working exactly as intended, and `last_success` is what every report reads to decide whether a
 * source has gone quiet. Leaving it behind would turn a package that has not shipped in a week into
 * an alarm. See `nothingNew` in src/sources/definition.ts for why the question is split out at all.
 */
async function markedUnchanged(db: Database, job: SourceDefinition): Promise<string | null> {
  const nothingNew = job.nothingNew;
  // Timed under its own name: this is the read that now happens every few minutes, and `timings`
  // should be able to say what asking that often costs.
  if (!nothingNew || !(await measure(db, `source.watch:${job.id}`, () => nothingNew()))) return null;
  const checkedAt = new Date().toISOString();
  db.query(
    "UPDATE sources SET last_success=?,checked_at=?,failures=0,retry_at=NULL,failure_started_at=NULL,last_error=NULL,last_error_kind=NULL WHERE id=?",
  ).run(checkedAt, checkedAt, job.id);
  log("info", "Source unchanged upstream", { source: job.id });
  return checkedAt;
}

/**
 * What the registry declares about a source, spread onto the answer it just gave. Authority,
 * evidence, confidence and whether an omission is a withdrawal are static facts about the surface
 * being read, not observations a collector makes; see src/sources/definition.ts.
 */
function underContract(job: SourceDefinition, collected: Collection): Collection {
  return {
    ...collected,
    authority: job.authority,
    evidence: job.evidence,
    confidence: job.confidence,
    ...(job.vendor ? { vendor: job.vendor } : {}),
    ...(job.appendOnly ? { appendOnly: true } : {}),
  };
}

/**
 * What one collection did, as the poller's log line says it and as `collect` answers with it.
 *
 * `unchanged` is not a smaller `collected`: upstream said the body has not moved, so nothing was
 * downloaded, nothing was parsed and no record was touched. Reporting it as zero records collected
 * would read as a source that went empty.
 */
export type SourceOutcome =
  | { source: string; status: "unchanged"; at: string }
  | { source: string; status: "collected"; records: number; events: number }
  | { source: string; status: "failed"; kind: string; error: string };

/**
 * One source, collected and stored, or its failure recorded against it. Never throws: a collector
 * that fails is a row in `sources` and `source_collection_metrics`, not an exception that ends the
 * cycle the other sources are sharing.
 *
 * `paced` is how the caller learns that this source has just spent its group's slot, which the
 * poller holds per cycle and a single forced collection does not need at all.
 */
/**
 * Everything one failed attempt writes, in one transaction.
 *
 * Lifted out of `collectSource` when adding the ON CONFLICT that migration 076 made necessary put
 * it one line over the length a declaration gets. It was the right thing to lift: the success path
 * has `recordOutcome` in the store and the failure path had twenty lines inline, and the two are
 * the same kind of thing -- what this loop records about an attempt, as opposed to what the
 * collection itself persists.
 */
function recordFailedAttempt(
  db: Database,
  job: SourceDefinition,
  diagnosis: Diagnosis,
  checkedAt: string,
  retryAt: string | null,
): void {
  const message = diagnosis.message;
  writeTransaction(db, () => {
    // The first failure of a run stamps when the outage began; later ones leave it alone, so
    // the duration is measured from the start rather than from the latest confirmation.
    db.query(
      `INSERT INTO sources(id,last_error,last_error_kind,checked_at,failures,retry_at,failure_started_at,first_observed_at) VALUES(?,?,?,?,1,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,last_error_kind=excluded.last_error_kind,checked_at=excluded.checked_at,
         failures=MIN(sources.failures+1,6),retry_at=excluded.retry_at,
         failure_started_at=COALESCE(sources.failure_started_at,excluded.failure_started_at),
         first_observed_at=COALESCE(sources.first_observed_at,excluded.first_observed_at)`,
    ).run(job.id, message, diagnosis.kind, checkedAt, retryAt, checkedAt, checkedAt);
    db.query(
      // As on the success path in `recordOutcome`: 076 made the key the table, and a collision
      // on the millisecond overwrites rather than throwing inside a collection.
      `INSERT INTO source_collection_metrics(source,collected_at,success,error,failure_kind) VALUES(?,?,0,?,?)
       ON CONFLICT(source, collected_at) DO UPDATE SET success=0, error=excluded.error, failure_kind=excluded.failure_kind`,
    ).run(job.id, checkedAt, message, diagnosis.kind);
    // As on the success path: the fold is what the failure rates are read from.
    addCollectionToDay(db, job.id, checkedAt);
    if (diagnosis.evidence) recordFailureEvidence(db, job.id, checkedAt, diagnosis.kind, diagnosis.evidence);
    // A failure breaks consecutive confirmation of a disappearance.
    db.query("UPDATE records SET missing_count=0 WHERE source=?").run(job.id);
  });
}

async function collectSource(
  db: Database,
  config: AppConfig,
  job: SourceDefinition,
  paced: (at: number) => void = () => {},
): Promise<SourceOutcome> {
  try {
    // A heavy source is collected in a child process: what parsing a large body costs is
    // never given back to the operating system, so it is spent somewhere that ends. See
    // src/sources/subprocess.ts.
    //
    // Not wrapped in `measure` here, however tempting: the registry already wraps every
    // definition's collector under `source.collect:<id>`, and the child builds that same
    // registry against the same database file, so a heavy collection is timed by the child and
    // a light one in this process. Timing it here as well recorded each collection twice under
    // one name, which inflates the call count and the total of the very report that is supposed
    // to catch a collector getting slower.
    // Upstream has not moved, so there is nothing to download and nothing to store. Timed under
    // its own name: this is the read that now happens every few minutes, and `timings` should be
    // able to say what asking that often costs.
    const unchangedAt = await markedUnchanged(db, job);
    if (unchangedAt) {
      paced(Date.parse(unchangedAt));
      return { source: job.id, status: "unchanged", at: unchangedAt };
    }
    const child = job.heavy ? await collectInSubprocess(db, config, job.id) : null;
    const collected = child ? child.collection : await job.collector();
    const collection = underContract(job, collected);
    const checkedAt = new Date().toISOString();
    const destinations = job.mode === "shadow" ? [] : config.destinations;
    // The backoff is cleared in the transaction that stores the read: a crash between the two
    // would otherwise leave a source that just succeeded waiting out an old retry time.
    const saved = measure(db, `source.persist:${job.id}`, () =>
      writeTransaction(db, () => {
        const emitted = saveCollection(
          db,
          collection,
          destinations,
          checkedAt,
          config.vendorRoles,
          config.allSignalsRole,
        );
        db.query(
          "UPDATE sources SET failures=0,retry_at=NULL,failure_started_at=NULL,last_error_kind=NULL WHERE id=?",
        ).run(job.id);
        // The shape of an answer that worked, so the next failure has something to be
        // compared against. Paths and types only: see src/shape.ts for why no value is kept.
        recordSourceShape(db, job.id, collection.raw, checkedAt);
        // What the child cost, onto the row `saveCollection` has just written for this moment.
        // Here rather than inside the store: the store persists evidence, and how much memory
        // another process took to fetch it is this loop's observation, not the collection's.
        // Keyed by the instant the same transaction wrote, so it can match no other run.
        if (child?.peakRssMb !== null && child?.peakRssMb !== undefined) {
          db.query("UPDATE source_collection_metrics SET peak_rss_mb=? WHERE source=? AND collected_at=?").run(
            child.peakRssMb,
            job.id,
            checkedAt,
          );
          // Written after the store counted this collection, so the peak is carried in separately.
          addPeakToDay(db, job.id, checkedAt, child.peakRssMb);
        }
        return emitted;
      }),
    );
    // Past the commit, so the cached projection describes stories that are actually stored.
    if (saved.projection) rememberStoryProjection(db, saved.projection);
    const events = saved.events;
    paced(Date.parse(checkedAt));
    log("info", "Source collected", { source: job.id, records: collection.records.length, events });
    return { source: job.id, status: "collected", records: collection.records.length, events };
  } catch (error) {
    // The kind comes off the type of the error, never off the shape of its message: see
    // sources/failureDiagnosis.ts for what the regular expression that used to live here let
    // through and what it withheld.
    const diagnosis = classifyFailure(error);
    const message = diagnosis.message;
    const checkedAt = new Date().toISOString();
    const retryAt = error instanceof SourceHttpError ? error.retryAt : null;
    recordFailedAttempt(db, job, diagnosis, checkedAt, retryAt);
    // A refused credential is not a link that dropped: the backoff would keep asking, and the
    // answer would keep being no. Stop every source carrying that credential until it is
    // replaced, and say which credential it was rather than which collector noticed.
    const status = error instanceof SourceHttpError && !error.rateLimited ? error.status : null;
    if (isCredentialRejection(status) && (job.requiredCapabilities ?? []).length)
      recordCredentialRejection(db, {
        capabilityId: job.capabilityId ?? job.id,
        source: job.id,
        statusCode: status,
        detail: message,
      });
    paced(Date.parse(checkedAt));
    log("warn", "Source collection failed", { source: job.id, kind: diagnosis.kind, error: message });
    return { source: job.id, status: "failed", kind: diagnosis.kind, error: message };
  }
}

async function collectDueSources(
  db: Database,
  config: AppConfig,
  force: boolean,
  lease?: AbortSignal,
): Promise<number> {
  const jobs = sourceJobs(db, config);
  const rows = new Map(
    jobs.map((job) => [
      job.id,
      db
        .query<{ checked_at: string | null; failures: number; retry_at: string | null }, [string]>(
          "SELECT checked_at,failures,retry_at FROM sources WHERE id=?",
        )
        .get(job.id),
    ]),
  );
  const pacedAt = new Map<string, number>();
  for (const job of jobs) {
    const checkedAt = rows.get(job.id)?.checked_at;
    if (job.pace && checkedAt)
      pacedAt.set(job.pace.group, Math.max(pacedAt.get(job.pace.group) ?? 0, Date.parse(checkedAt)));
  }

  const ordered = byLongestWait(jobs, (id) => rows.get(id)?.checked_at ?? null);

  const dueJobs: SourceDefinition[] = [];
  for (const job of ordered) {
    const last = rows.get(job.id);
    const now = Date.now();
    // Even a forced run waits out a server's own Retry-After: asking early is what earned it.
    if (last?.retry_at && Date.parse(last.retry_at) > now) continue;
    if (!force && !due(last?.checked_at ?? null, job.intervalSeconds, last?.failures ?? 0, now)) continue;
    if (job.pace && now - (pacedAt.get(job.pace.group) ?? 0) < job.pace.seconds * 1000) continue;
    // Reserve a paced group before any collector awaits network I/O; otherwise concurrent jobs
    // on one host would all pass the check and violate the upstream request budget.
    if (job.pace) pacedAt.set(job.pace.group, now);
    dueJobs.push(job);
  }

  // A source whose response is tens of megabytes holds that, and the objects parsed from it, until
  // it is stored. Two of them at once are what the container's memory peaks are made of, so they
  // share one lane and take turns; everything else keeps the remaining lanes. Each of them also
  // runs in a child process, so the lane bounds how many children exist at once.
  const heavy = dueJobs.filter((job) => job.heavy);
  const light = dueJobs.filter((job) => !job.heavy);
  const worker = async (queue: SourceDefinition[]): Promise<void> => {
    while (queue.length) {
      // Between two sources is the safe place to notice. The lease was lost while this cycle was
      // running, which means another process is already collecting the same sources; finishing the
      // queue would write both of their answers over each other. The sources not reached are due
      // again immediately, and the holder that took the lease is the one collecting them.
      if (lease?.aborted) {
        log("warn", "Collection cycle stopped: the lease was taken by another holder", { remaining: queue.length });
        return;
      }
      const job = queue.shift();
      if (!job) return;
      await collectSource(db, config, job, (at) => {
        if (job.pace) pacedAt.set(job.pace.group, at);
      });
    }
  };
  const lightLanes = Math.min(MAX_CONCURRENT_SOURCES - (heavy.length ? 1 : 0), light.length);
  await Promise.all([
    ...(heavy.length ? [worker(heavy)] : []),
    ...Array.from({ length: lightLanes }, () => worker(light)),
  ]);
  return dueJobs.length;
}
