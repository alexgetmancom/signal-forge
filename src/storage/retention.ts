import type { Database } from "bun:sqlite";
import { log } from "../logger.js";

/**
 * Raw collection payloads are kept so that any event can be traced back to the bytes it came from.
 * Most are small; a few are not. One npm registry document is 14 MB because it carries every
 * version ever published, and one rendered web page is 21 MB — stored on every poll, those two
 * sources alone filled 570 MB of a 1.17 GB database in four days, and nothing was ever deleted.
 *
 * The newest payloads are what a person actually opens when a card looks wrong, so a few of those
 * stay whatever their age, along with everything collected in the last few hours while a problem
 * is still being looked at.
 *
 * Nothing an event points at is ever deleted. Every event names the snapshot it was derived from,
 * and a card that cannot be traced back to the bytes it came from is a claim without evidence —
 * which is the one thing this database exists to avoid. The first version of this cleanup did not
 * check, and the foreign key stopped it; that refusal was the database doing its job.
 */
const KEEP_PER_SOURCE = 3;
const KEEP_HOURS = 6;
/**
 * Rows per statement. The payloads behind them are large enough that deleting a backlog in one
 * statement writes hundreds of megabytes into the journal at once, on a service that has already
 * been killed once for holding a whole database in memory. Fifty is what production actually
 * swallowed; one statement for the whole backlog did not.
 */
const CHUNK = 50;
const MAX_CHUNKS = 200;

export function pruneSnapshots(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - KEEP_HOURS * 3_600_000).toISOString();
  let removed = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    try {
      const deleted = db
        .query<{ removed: number }, [number, string, number]>(
          `DELETE FROM snapshots WHERE id IN (
             SELECT id FROM (
               SELECT id, collected_at, ROW_NUMBER() OVER (PARTITION BY source ORDER BY id DESC) AS recency
               FROM snapshots
               WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.snapshot_id = snapshots.id)
             ) WHERE recency > ? AND collected_at < ? LIMIT ?
           ) RETURNING 1 AS removed`,
        )
        .all(KEEP_PER_SOURCE, cutoff, CHUNK).length;
      removed += deleted;
      if (deleted < CHUNK) return removed;
    } catch (error) {
      // A database that cannot prune is still a database that collects; it must not stop the
      // cycle, but a silent failure is how this grew to a gigabyte unnoticed in the first place.
      log("warn", "Snapshot retention cleanup failed", {
        errorType: error instanceof Error ? error.message : "unknown",
        removed,
      });
      return removed;
    }
  }
  return removed;
}

/**
 * How long a payload's bytes are worth keeping. Ninety days is far past the point where anybody
 * opens the raw document behind a card, and a service that reports what is new has no use for the
 * exact HTML of a page from last spring.
 *
 * What is released is only the body. The row keeps the source, the time, the hash of the bytes and
 * their original size, which is a receipt that the evidence existed and what it was; the event
 * keeps its own before and after state, which is what every card is actually drawn from.
 */
const BODY_LIFETIME_DAYS = 30;

/**
 * A payload larger than a megabyte keeps its bytes for two days.
 *
 * Measured on production 2026-09-19: snapshots held 422 MB of a 681 MB database, and 239 MB of it
 * was 34 copies of the `claude-web` bundle at about 7 MB each, all inside the old fourteen-day
 * window. Naming the heavy sources one by one also missed `models-dev` (36 MB) and `openrouter`
 * (32 MB). Size is the property that matters, so size decides. Every event keeps its own before
 * and after state, so what this costs is the raw bytes behind a card older than two days.
 */
const HEAVY_BODY_LIFETIME_DAYS = 2;
const HEAVY_BODY_BYTES = 1_000_000;

export function expireSnapshotBodies(db: Database, now = Date.now()): number {
  const cutoff = (days: number) => new Date(now - days * 24 * 3_600_000).toISOString();
  try {
    return db
      .query<{ expired: number }, (string | number)[]>(
        `UPDATE snapshots SET body=NULL, expired_at=?
         WHERE id IN (
           SELECT id FROM snapshots
           WHERE body IS NOT NULL
             -- The bound first, so the partial index on (collected_at) WHERE body IS NOT NULL can
             -- seek. A row can only qualify under either horizon if it is older than the shorter
             -- one, so this admits exactly the CASE's rows and no more; the CASE then decides which
             -- horizon each of those actually falls under. With the CASE alone the predicate is not
             -- a range over any column and SQLite scans every unexpired snapshot to find the few.
             AND collected_at < ?
             AND collected_at < (CASE WHEN bytes > ? THEN ? ELSE ? END)
           LIMIT ?
         ) RETURNING 1 AS expired`,
      )
      .all(
        new Date(now).toISOString(),
        cutoff(Math.min(HEAVY_BODY_LIFETIME_DAYS, BODY_LIFETIME_DAYS)),
        HEAVY_BODY_BYTES,
        cutoff(HEAVY_BODY_LIFETIME_DAYS),
        cutoff(BODY_LIFETIME_DAYS),
        CHUNK * MAX_CHUNKS,
      ).length;
  } catch (error) {
    log("warn", "Snapshot body expiry failed", { errorType: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

/**
 * Every collection attempt writes a row here, success or failure, and nothing ever deleted one.
 *
 * Measured on production 2026-09-24: 146,529 rows against 11,131 events, growing by 15--21 thousand
 * a day and accelerating with each source added. It is the only operational table that was never
 * given a horizon -- `code_metrics` has ninety days, snapshots have theirs -- and the reports that
 * read it never look past a week.
 *
 * Ninety days, to match the metrics it sits beside: long enough that a source's failure rate over
 * a quarter is still answerable, short enough that the table stops being the largest thing in the
 * database that nobody reads.
 *
 * Thirty was considered and rejected. `sourceVerdicts` reads `MIN(collected_at)` across all of
 * history to say how long a source has been observed, and that number decides whether a source is
 * old enough to be judged at all. Shorten the horizon and every source's apparent age silently
 * caps at the horizon: the verdicts keep rendering, with a wrong denominator. Any future change to
 * this constant has to answer that query first.
 */
const COLLECTION_METRICS_LIFETIME_DAYS = 90;

export function pruneSourceCollectionMetrics(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - COLLECTION_METRICS_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  let removed = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    try {
      // Chunked like the snapshots above: the first run after this ships has a six-figure backlog
      // to clear, and one statement for all of it holds a write lock for the length of it.
      const deleted = db
        .query<{ removed: number }, [string, number]>(
          `DELETE FROM source_collection_metrics WHERE rowid IN (
             SELECT rowid FROM source_collection_metrics WHERE collected_at < ? LIMIT ?
           ) RETURNING 1 AS removed`,
        )
        .all(cutoff, CHUNK * 20).length;
      removed += deleted;
      if (deleted < CHUNK * 20) return removed;
    } catch (error) {
      log("warn", "Collection metrics retention cleanup failed", {
        errorType: error instanceof Error ? error.message : "unknown",
        removed,
      });
      return removed;
    }
  }
  return removed;
}

/**
 * Shadow sources scan everything a registry publishes to find the few uploads worth watching.
 * Those rows are candidates, not evidence: they were never sent to anybody and never corroborated
 * anything. Six thousand of them accumulated in four days, and the ones nothing ever referred to
 * are the only rows here that can be deleted without losing an answer to a question.
 */
const CANDIDATE_LIFETIME_DAYS = 30;

export function pruneShadowCandidates(db: Database, shadowSources: readonly string[], now = Date.now()): number {
  if (!shadowSources.length) return 0;
  const cutoff = new Date(now - CANDIDATE_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  const marks = shadowSources.map(() => "?").join(",");
  try {
    const removed = db
      .query<{ removed: number }, (string | number)[]>(
        `DELETE FROM events WHERE id IN (
           SELECT e.id FROM events e
           WHERE e.source IN (${marks}) AND e.detected_at < ?
             AND NOT EXISTS (SELECT 1 FROM batch_events be WHERE be.event_id = e.id)
           LIMIT ?
         ) RETURNING 1 AS removed`,
      )
      .all(...shadowSources, cutoff, CHUNK * MAX_CHUNKS).length;
    // A story whose every event has gone is not a story any more.
    db.query(
      "DELETE FROM stories WHERE NOT EXISTS (SELECT 1 FROM story_events se WHERE se.story_id = stories.id)",
    ).run();
    return removed;
  } catch (error) {
    log("warn", "Shadow candidate cleanup failed", { errorType: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

/** What the database weighs now, and what it weighed a day ago, so growth is a number not a surprise. */
export function databaseSize(db: Database): { bytes: number; snapshotBytes: number } {
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const snapshotBytes =
    db.query<{ total: number | null }, []>("SELECT SUM(LENGTH(body)) AS total FROM snapshots").get()?.total ?? 0;
  return { bytes: pages * pageSize, snapshotBytes };
}

/**
 * The operator journal, now that it records reads and not only writes.
 *
 * It was a slow table while it held mutations alone -- a few hundred rows a year. Recording every
 * call changes the shape: 558 `sql` invocations in a fortnight on production, before any of the
 * new commands existed, and an agent session asks more questions than a person does. Kept long
 * enough for `usage` to still have a fortnight of evidence after a quiet month, which is what the
 * missing-command detector needs to see a repeat.
 */
const JOURNAL_LIFETIME_DAYS = 120;

export function pruneOperatorJournal(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - JOURNAL_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  let removed = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    try {
      const deleted = db
        .query<{ removed: number }, [string, number]>(
          `DELETE FROM operator_journal WHERE rowid IN (
             SELECT rowid FROM operator_journal WHERE recorded_at < ? LIMIT ?
           ) RETURNING 1 AS removed`,
        )
        .all(cutoff, CHUNK * 20).length;
      removed += deleted;
      if (deleted < CHUNK * 20) return removed;
    } catch (error) {
      log("warn", "Operator journal retention cleanup failed", {
        errorType: error instanceof Error ? error.message : "unknown",
        removed,
      });
      return removed;
    }
  }
  return removed;
}
