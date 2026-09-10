import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { saveCollection } from "./events/pipeline.js";
import { CollectionDegradedError } from "./events/store.js";
import { log } from "./logger.js";
import { measure } from "./runtime/metrics.js";
import { SourceHttpError } from "./sources/http.js";
import { type SourceJob, sourceJobs } from "./sources/registry.js";

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

export async function pollSources(db: Database, config: AppConfig, force = false): Promise<void> {
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

  const dueJobs: SourceJob[] = [];
  for (const job of jobs) {
    const last = rows.get(job.id);
    const now = Date.now();
    if (last?.retry_at && Date.parse(last.retry_at) > now) continue;
    if (!force && !due(last?.checked_at ?? null, job.interval, last?.failures ?? 0, now)) continue;
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
        const collection = { ...(await job.run()), authority: job.authority };
        const checkedAt = new Date().toISOString();
        const destinations = job.mode === "shadow" ? [] : config.destinations;
        const events = measure(db, `source.persist:${job.id}`, () =>
          saveCollection(db, collection, destinations, checkedAt, config.vendorRoles),
        );
        db.query("UPDATE sources SET failures=0,retry_at=NULL WHERE id=?").run(job.id);
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
          db.query(
            `INSERT INTO sources(id,last_error,checked_at,failures,retry_at) VALUES(?,?,?,1,?)
           ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at,
             failures=MIN(sources.failures+1,6),retry_at=excluded.retry_at`,
          ).run(job.id, message, checkedAt, retryAt);
          db.query("INSERT INTO source_collection_metrics(source,collected_at,success,error) VALUES(?,?,0,?)").run(
            job.id,
            checkedAt,
            message,
          );
          // A failure breaks consecutive confirmation of a disappearance.
          db.query("UPDATE records SET missing_count=0 WHERE source=?").run(job.id);
        })();
        if (job.pace) pacedAt.set(job.pace.group, Date.parse(checkedAt));
        log("warn", "Source collection failed", { source: job.id, error: message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SOURCES, dueJobs.length) }, () => worker()));
}
