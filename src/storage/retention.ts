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
const BODY_LIFETIME_DAYS = 90;

export function expireSnapshotBodies(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - BODY_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  try {
    return db
      .query<{ expired: number }, [string, string, number]>(
        `UPDATE snapshots SET body=NULL, expired_at=?
         WHERE id IN (SELECT id FROM snapshots WHERE body IS NOT NULL AND collected_at < ? LIMIT ?)
         RETURNING 1 AS expired`,
      )
      .all(new Date(now).toISOString(), cutoff, CHUNK * MAX_CHUNKS).length;
  } catch (error) {
    log("warn", "Snapshot body expiry failed", { errorType: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
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
