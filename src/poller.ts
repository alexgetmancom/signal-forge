import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { isCredentialRejection, recordCredentialRejection } from "./credentials.js";
import { saveCollection } from "./events/pipeline.js";
import { CollectionDegradedError } from "./events/store.js";
import { log } from "./logger.js";
import { lockHolder, withActionLock } from "./runtime/actionLock.js";
import { measure } from "./runtime/metrics.js";
import { SourceHttpError } from "./sources/http.js";
import { type SourceDefinition, sourceJobs } from "./sources/registry.js";

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

/**
 * What kind of failure this was, in words that can carry no credential and no response body.
 *
 * The message is withheld because it can quote either. That used to withhold everything: Artificial
 * Analysis failed inside a collection cycle on 2026-09-16 and passed every reproduction outside one,
 * and "network or schema validation error" could not say which half had happened. The class of the
 * error and the transport's own code are names chosen by the runtime, never by the upstream.
 */
export function unexplainedFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code = [error, cause]
    .map((value) => (value && typeof value === "object" ? (value as { code?: unknown }).code : undefined))
    .find((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(value));
  // `SQLITE_BUSY` from an operator poll racing the service was reported as a network error on
  // 2026-09-16, which sends whoever reads it to the router instead of to the lock.
  const kind =
    name === "ZodError" || name === "SyntaxError"
      ? "response did not match the schema"
      : name === "SQLiteError"
        ? "local database error"
        : name === "TypeError" || name === "AbortError" || name === "TimeoutError" || code?.startsWith("E")
          ? "network error"
          : "unexpected error";
  return `Collection failed: ${kind} (${[name, code].filter(Boolean).join(", ")})`;
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

export async function pollSources(db: Database, config: AppConfig, force = false): Promise<PollOutcome> {
  const outcome = await withActionLock(db, "collection", lockHolder("poller"), COLLECTION_LEASE_MS, () =>
    collectDueSources(db, config, force),
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

async function collectDueSources(db: Database, config: AppConfig, force: boolean): Promise<number> {
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
  // share one lane and take turns; everything else keeps the remaining lanes.
  const heavy = dueJobs.filter((job) => job.heavy);
  const light = dueJobs.filter((job) => !job.heavy);
  const worker = async (queue: SourceDefinition[]): Promise<void> => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      try {
        const collected = await job.collector();
        const collection = { ...collected, authority: job.authority, ...(job.vendor ? { vendor: job.vendor } : {}) };
        const checkedAt = new Date().toISOString();
        const destinations = job.mode === "shadow" ? [] : config.destinations;
        // The backoff is cleared in the transaction that stores the read: a crash between the two
        // would otherwise leave a source that just succeeded waiting out an old retry time.
        const events = measure(db, `source.persist:${job.id}`, () =>
          db.transaction(() => {
            const emitted = saveCollection(
              db,
              collection,
              destinations,
              checkedAt,
              config.vendorRoles,
              config.allSignalsRole,
            );
            db.query("UPDATE sources SET failures=0,retry_at=NULL,failure_started_at=NULL WHERE id=?").run(job.id);
            return emitted;
          })(),
        );
        if (job.pace) pacedAt.set(job.pace.group, Date.parse(checkedAt));
        log("info", "Source collected", { source: job.id, records: collection.records.length, events });
      } catch (error) {
        // Source errors may contain credentials or an entire invalid response. Keep a safe operational category.
        const message =
          error instanceof CollectionDegradedError
            ? error.message
            : error instanceof Error &&
                /^(Source |Public page |GitHub |Anthropic |Gemini |Invalid RSS|.*: empty collection|.*: duplicate record|.*: invalid normalized record)/.test(
                  error.message,
                )
              ? error.message
              : unexplainedFailure(error);
        const checkedAt = new Date().toISOString();
        const retryAt = error instanceof SourceHttpError ? error.retryAt : null;
        db.transaction(() => {
          // The first failure of a run stamps when the outage began; later ones leave it alone, so
          // the duration is measured from the start rather than from the latest confirmation.
          db.query(
            `INSERT INTO sources(id,last_error,checked_at,failures,retry_at,failure_started_at) VALUES(?,?,?,1,?,?)
           ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at,
             failures=MIN(sources.failures+1,6),retry_at=excluded.retry_at,
             failure_started_at=COALESCE(sources.failure_started_at,excluded.failure_started_at)`,
          ).run(job.id, message, checkedAt, retryAt, checkedAt);
          db.query("INSERT INTO source_collection_metrics(source,collected_at,success,error) VALUES(?,?,0,?)").run(
            job.id,
            checkedAt,
            message,
          );
          // A failure breaks consecutive confirmation of a disappearance.
          db.query("UPDATE records SET missing_count=0 WHERE source=?").run(job.id);
        })();
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
        if (job.pace) pacedAt.set(job.pace.group, Date.parse(checkedAt));
        log("warn", "Source collection failed", { source: job.id, error: message });
      }
    }
  };
  const lightLanes = Math.min(MAX_CONCURRENT_SOURCES - (heavy.length ? 1 : 0), light.length);
  await Promise.all([
    ...(heavy.length ? [worker(heavy)] : []),
    ...Array.from({ length: lightLanes }, () => worker(light)),
  ]);
  return dueJobs.length;
}
