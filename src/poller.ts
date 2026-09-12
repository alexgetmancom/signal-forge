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
 */
export function due(checkedAt: string | null, interval: number, failures: number, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - Date.parse(checkedAt) >= interval * Math.min(2 ** failures, 8) * 1000;
}

export type PollOutcome = { collected: boolean; sources: number; heldBy?: string };

/**
 * One collection cycle at a time, whoever asked for it. The service polls on a timer and the
 * operator polls from the CLI while investigating a source; those are two processes against one
 * database file, and a source collected twice in the same second writes evidence that disagrees
 * with itself. The lease lives in the database because that is the only thing both of them share.
 */
export async function pollSources(db: Database, config: AppConfig, force = false): Promise<PollOutcome> {
  const outcome = await withActionLock(db, "collection", lockHolder("poller"), 15 * 60_000, () =>
    collectDueSources(db, config, force),
  );
  if (outcome.acquired) return { collected: true, sources: outcome.result };
  log("info", "Collection cycle skipped", { heldBy: outcome.heldBy.holder });
  return { collected: false, sources: 0, heldBy: outcome.heldBy.holder };
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

  const dueJobs: SourceDefinition[] = [];
  for (const job of jobs) {
    const last = rows.get(job.id);
    const now = Date.now();
    if (last?.retry_at && Date.parse(last.retry_at) > now) continue;
    if (!force && !due(last?.checked_at ?? null, job.intervalSeconds, last?.failures ?? 0, now)) continue;
    if (job.pace && now - (pacedAt.get(job.pace.group) ?? 0) < job.pace.seconds * 1000) continue;
    // Reserve a paced group before any collector awaits network I/O; otherwise concurrent jobs
    // on one host would all pass the check and violate the upstream request budget.
    if (job.pace) pacedAt.set(job.pace.group, now);
    dueJobs.push(job);
  }

  let nextJob = 0;
  const worker = async (): Promise<void> => {
    while (nextJob < dueJobs.length) {
      const job = dueJobs[nextJob];
      nextJob += 1;
      if (!job) return;
      try {
        const collection = { ...(await job.collector()), authority: job.authority };
        const checkedAt = new Date().toISOString();
        const destinations = job.mode === "shadow" ? [] : config.destinations;
        const events = measure(db, `source.persist:${job.id}`, () =>
          saveCollection(db, collection, destinations, checkedAt, config.vendorRoles, config.allSignalsRole),
        );
        db.query("UPDATE sources SET failures=0,retry_at=NULL,failure_started_at=NULL WHERE id=?").run(job.id);
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
              : "Collection failed: network or schema validation error";
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
        const status = error instanceof SourceHttpError ? error.status : null;
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
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SOURCES, dueJobs.length) }, () => worker()));
  return dueJobs.length;
}
