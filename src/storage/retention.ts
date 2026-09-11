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
 * is still being looked at. The rest is evidence nobody has asked for, and the events it produced
 * keep their own before and after state regardless.
 */
const KEEP_PER_SOURCE = 3;
const KEEP_HOURS = 6;
/**
 * Rows per statement. The payloads behind them are large enough that deleting a backlog in one
 * statement writes hundreds of megabytes into the journal at once, on a service that has already
 * been killed once for holding a whole database in memory.
 */
const CHUNK = 200;
const MAX_CHUNKS = 50;

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
