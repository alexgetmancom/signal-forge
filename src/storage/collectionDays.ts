import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { FAILURE_KIND } from "../reports/failureKind.js";
import { writeTransaction } from "./transaction.js";

/**
 * The daily fold of `source_collection_metrics`, and the only thing any count of collections is
 * read from.
 *
 * Counts are read from the fold. Raw failures keep fourteen days for outage minutes and example
 * sentences; successful attempts keep the repair window and each source's latest five readings.
 *
 * Two things stay raw, because a fold cannot answer them: the minute an outage clustered in, which
 * `outages` groups by, and the sentence a failure carried, which `failures` shows one of.
 */

/**
 * How many days back the cycle's fold recomputes.
 *
 * Yesterday as well as today, because a cycle that runs at midnight sees a day still gaining rows,
 * and because the status worker is not guaranteed to have run at all during a day. A collection
 * folds its own day only, which is the day it just wrote to.
 */
export const REFOLD_DAYS = 2;
/** The individual readings `sourceProfile` exposes, including sources that run rarely. */
export const LATEST_COLLECTIONS = 5;

const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/**
 * The day a window beginning at this instant starts in.
 *
 * A window over the fold is whole days, because a day is the smallest thing it holds. A report that
 * asks for seven days therefore counts from the start of the seventh day back rather than from this
 * hour of it, and a report that states its window has to state that one: `collectionWindowFrom`
 * below is what it states, so the bound a reader is shown is the bound that was counted.
 */
export const dayFrom = (iso: string): string => iso.slice(0, 10);

/** The instant a whole-day window of this many days begins, for a report to count from and to show. */
export function collectionWindowFrom(days: number, now: number): string {
  return `${dayFrom(new Date(now - days * 24 * 3_600_000).toISOString())}T00:00:00.000Z`;
}

/**
 * Adds the one collection that was just written to the day it belongs to.
 *
 * This is what the hot path calls, and the reason it exists is contention rather than speed. Every
 * collection used to recompute its whole day: delete every row of today and rebuild them by
 * grouping the raw attempts, inside the same write transaction that stored the collection. By the
 * four-hundredth collection of a day that is a scan and a rewrite of four hundred rows to record
 * one, and it holds the write lock for the length of it. Production carries 27 collections lost to
 * `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT`, so the length of a write transaction is measured here
 * in lost evidence, not in milliseconds.
 *
 * The outcome is derived in SQL from the raw row this just wrote, by primary-key seek on
 * (source, collected_at), rather than passed in: `FAILURE_KIND` is the one place that decides what
 * kind a failure was, and a second copy of that decision in TypeScript is a fold that disagrees
 * with the repair below about what a day contains.
 *
 * Adding rather than replacing is safe because `foldCollectionDays` remains the ground truth: it
 * recomputes the last two days from the raw attempts on every cycle, so a sum that drifted -- a
 * crash between the raw insert and this, a day that turned over mid-collection -- is corrected
 * within one cycle rather than carried. What this buys is that a report asked a second after a
 * collection already counts it.
 */
export function addCollectionToDay(db: Database, source: string, collectedAt: string): void {
  try {
    db.query<null, [string, string]>(
      `INSERT INTO source_collection_days(
         source, day, outcome, attempts, records_processed, events_created, new_events,
         changed_events, removed_events, peak_rss_max, peak_rss_total, peak_rss_samples,
         first_at, last_at
       )
       SELECT source,
              substr(collected_at, 1, 10),
              CASE WHEN success = 1 THEN 'success' ELSE ${FAILURE_KIND} END,
              1, records_processed, events_created, new_events, changed_events, removed_events,
              peak_rss_mb, peak_rss_mb, (peak_rss_mb IS NOT NULL), collected_at, collected_at
       FROM source_collection_metrics WHERE source = ? AND collected_at = ?
       ON CONFLICT(day, source, outcome) DO UPDATE SET
         attempts = attempts + 1,
         records_processed = records_processed + excluded.records_processed,
         events_created = events_created + excluded.events_created,
         new_events = new_events + excluded.new_events,
         changed_events = changed_events + excluded.changed_events,
         removed_events = removed_events + excluded.removed_events,
         -- COALESCE on both sides so one null does not erase the other side's number, and the pair
         -- staying null when neither has one. The same shape as the fold's MAX over the raw rows.
         peak_rss_max = MAX(COALESCE(peak_rss_max, excluded.peak_rss_max), COALESCE(excluded.peak_rss_max, peak_rss_max)),
         -- Null rather than zero when neither side measured anything, because that is what the
         -- repair's SUM over rows that all lack a peak returns, and a 0 here would be a day whose
         -- total disagrees with the fold the moment the cycle rewrites it.
         peak_rss_total = CASE
           WHEN peak_rss_total IS NULL AND excluded.peak_rss_total IS NULL THEN NULL
           ELSE COALESCE(peak_rss_total, 0) + COALESCE(excluded.peak_rss_total, 0)
         END,
         peak_rss_samples = peak_rss_samples + excluded.peak_rss_samples,
         first_at = MIN(first_at, excluded.first_at),
         last_at = MAX(last_at, excluded.last_at)`,
    ).run(source, collectedAt);
  } catch (error) {
    // The cycle's fold repairs this within two days, so a failure here costs a report that is
    // seconds stale, not a count that is wrong forever. It must still be loud.
    log("warn", "Collection day increment failed", {
      source,
      errorType: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Carries a child process's peak memory into the day after the collection has already committed.
 *
 * The poller stamps `peak_rss_mb` onto the raw row once the subprocess has exited, which is past
 * the transaction that `addCollectionToDay` ran in, so the day was folded without it. Raising the
 * maximum and adding one sample is the same arithmetic the fold does over the raw rows; it is
 * correct exactly once per collection, which is how often the poller stamps one.
 */
export function addPeakToDay(db: Database, source: string, collectedAt: string, peakRssMb: number): void {
  try {
    db.query<null, [number, number, number, string, string]>(
      `UPDATE source_collection_days
       SET peak_rss_max = MAX(COALESCE(peak_rss_max, ?), ?),
           peak_rss_total = COALESCE(peak_rss_total, 0) + ?,
           peak_rss_samples = peak_rss_samples + 1
       WHERE day = substr(?, 1, 10) AND source = ? AND outcome = 'success'`,
    ).run(peakRssMb, peakRssMb, peakRssMb, collectedAt, source);
  } catch (error) {
    log("warn", "Collection day peak increment failed", {
      source,
      errorType: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Recomputes the last few days from the raw attempts.
 *
 * Deleting the day and inserting it again, rather than adding to what is there, is what makes this
 * safe to run as often as it is: a day folded twice must not count twice, whatever
 * `addCollectionToDay` has already added to it. That is the division of labour -- the hot path adds
 * one row's worth and this discards and recomputes, so an increment that was lost or double-counted
 * survives at most one cycle, and no report is ever reading a sum nothing checks.
 */
export function foldCollectionDays(db: Database, now = Date.now(), days = REFOLD_DAYS): number {
  const from = dayOf(now - (days - 1) * 24 * 3_600_000);
  try {
    return writeTransaction(db, () => {
      db.query("DELETE FROM source_collection_days WHERE day >= ?").run(from);
      return db
        .query<{ folded: number }, [string]>(
          `INSERT INTO source_collection_days(
             source, day, outcome, attempts, records_processed, events_created, new_events,
             changed_events, removed_events, peak_rss_max, peak_rss_total, peak_rss_samples,
             first_at, last_at
           )
           SELECT source,
                  substr(collected_at, 1, 10) AS day,
                  CASE WHEN success = 1 THEN 'success' ELSE ${FAILURE_KIND} END AS outcome,
                  COUNT(*),
                  SUM(records_processed),
                  SUM(events_created),
                  SUM(new_events),
                  SUM(changed_events),
                  SUM(removed_events),
                  MAX(peak_rss_mb),
                  SUM(peak_rss_mb),
                  SUM(peak_rss_mb IS NOT NULL),
                  MIN(collected_at),
                  MAX(collected_at)
           FROM source_collection_metrics
           WHERE collected_at >= ?
           GROUP BY source, day, outcome
           RETURNING 1 AS folded`,
        )
        .all(`${from}T00:00:00.000Z`).length;
    });
  } catch (error) {
    // A fold that failed is a report that is a day stale, not a service that stops collecting. It
    // must be loud, though: the prune below refuses to delete a day this has not recorded, so a
    // fold that silently stopped shows up as a raw table that stops shrinking.
    log("warn", "Collection day fold failed", { errorType: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}
