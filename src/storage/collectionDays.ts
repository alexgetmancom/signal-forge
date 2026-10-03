import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { FAILURE_KIND } from "../reports/failureKind.js";
import { writeTransaction } from "./transaction.js";

/**
 * The daily fold of `source_collection_metrics`, and the only thing any count of collections is
 * read from.
 *
 * The raw table keeps one row per attempt and nothing ever read an individual one: every report
 * asks how many, how many failed, and of what kind. Folding those into a row per source, day and
 * outcome is the same answer in a twentieth of the space, which is what lets the raw attempts stop
 * at a fortnight instead of a quarter.
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
const REFOLD_DAYS = 2;

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
 * Recomputes the last few days from the raw attempts.
 *
 * Deleting the day and inserting it again, rather than adding to what is there, is what makes this
 * safe to run as often as it is: a day folded twice must not count twice, and a collection folds
 * its own day on the way in so that a report asked a second later counts it. The cycle's wider
 * recompute is then a repair rather than the only writer -- it is what picks up the child's peak
 * memory, which the poller stamps onto the raw row after the collection has already committed.
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
