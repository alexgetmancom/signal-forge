import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { log } from "../logger.js";
import { FAILURE_KIND } from "../reports/failureKind.js";
import { METRIC_DAYS } from "../runtime/metricRecording.js";
import { LATEST_COLLECTIONS, REFOLD_DAYS } from "./collectionDays.js";

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
 * Ordinary payloads keep thirty days of raw evidence. The latest answer of each source remains
 * readable whatever its age, including sources that keep serving identical bytes.
 *
 * What is released is only the body. The row keeps the source, the time, the hash of the bytes and
 * their original size, which is a receipt that the evidence existed and what it was; the event
 * keeps its own before and after state, which is what every card is actually drawn from.
 */
const BODY_LIFETIME_DAYS = 30;

/**
 * A payload larger than half a megabyte keeps its bytes for two days.
 *
 * Measured on production 2026-10-03: OpenRouter held 106 MB in 1,384 snapshots whose original
 * sizes were 702--765 KB, all below the old one-megabyte threshold. The catalogue is copied when
 * one price changes. Half a megabyte admits those copies to the short window; events retain their
 * before and after state, while older raw bodies become receipts.
 */
const HEAVY_BODY_LIFETIME_DAYS = 2;
const HEAVY_BODY_BYTES = 500_000;

/**
 * How many bytes of raw bodies one source may hold, newest first.
 *
 * The two horizons above bound age and nothing bounds volume, so what a source costs is decided by
 * how often it is polled and how large its answer is -- neither of which this file knows. Measured
 * on a copy of production 2026-10-03: the two most expensive sources were `models-dev`, 28 bodies
 * of 537 KB stored in two days, and `openrouter`, 188 of 79 KB in the same two days. 15.0 MB and
 * 14.8 MB, from opposite ends of the per-body size the heavy rule is written in terms of. A
 * threshold on one body cannot see that.
 *
 * So this is the ceiling the horizons do not provide, and it is in stored bytes because stored
 * bytes are what the disk pays. Eight megabytes keeps 80.6 MB of the 97.5 MB that was there, and
 * what it costs is hours at the far end of the heaviest sources: `models-dev` keeps 16 bodies back
 * to 37 hours and `openrouter` 107 back to 31, against the two days the heavy horizon promises.
 * Every source light enough not to reach the ceiling is untouched and still keeps its thirty days.
 *
 * The number that matters is not today's 17 MB. It is that a source which starts answering ten
 * times larger, or being polled ten times more often, now costs eight megabytes instead of
 * however much that turns out to be.
 *
 * `LENGTH(body)` of a BLOB is read from the row header, not from the overflow pages, so summing it
 * over every unexpired body is 9 ms and no resident memory. The same sum over a TEXT column would
 * read all 97 MB.
 */
const SOURCE_BODY_BUDGET_BYTES = 8 * 1024 ** 2;

export function expireSnapshotBodies(db: Database, now = Date.now()): number {
  return expireByAge(db, now) + expireOverBudget(db, now);
}

/**
 * The bodies a source holds beyond its budget, newest kept.
 *
 * The newest body of each source sums to nothing ahead of it, so it can never be chosen -- which is
 * the same promise the age rule makes, that the latest answer of a source stays readable whatever
 * its age.
 */
function expireOverBudget(db: Database, now: number): number {
  try {
    return db
      .query<{ expired: number }, [string, number, number]>(
        `UPDATE snapshots SET body=NULL, expired_at=?
         WHERE id IN (
           SELECT id FROM (
             SELECT id, COALESCE(SUM(LENGTH(body)) OVER (
               PARTITION BY source ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ), 0) AS newerBytes
             FROM snapshots WHERE body IS NOT NULL
           ) WHERE newerBytes > ?
           LIMIT ?
         ) RETURNING 1 AS expired`,
      )
      .all(new Date(now).toISOString(), SOURCE_BODY_BUDGET_BYTES, CHUNK * MAX_CHUNKS).length;
  } catch (error) {
    log("warn", "Snapshot body budget sweep failed", {
      errorType: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
}

function expireByAge(db: Database, now: number): number {
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
             AND EXISTS (SELECT 1 FROM snapshots newer WHERE newer.source=snapshots.source AND newer.id>snapshots.id)
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
 * How long raw failures are kept, now that counts are read from the daily fold.
 *
 * Ninety days was the horizon while this table was what the reports read, and it could not be
 * shortened: `sourceVerdicts` reads the first successful collection across all of history to say
 * how long a source has been observed, and a shorter horizon silently caps every source's apparent
 * age at the horizon -- the verdicts keep rendering, with a wrong denominator. `signalQuality` and
 * five other reports take a window of up to ninety days for the same reason.
 *
 * `source_collection_days` answers all of those now and keeps the full ninety days of them, so what
 * a raw attempt is still needed for is the two things a fold cannot carry: the minute `outages`
 * clusters a failure in, and the sentence `failures` shows an example of. A fortnight covers both --
 * `outages` and the raw half of `failures` are capped to it in one place, `RAW_COLLECTION_DAYS`,
 * so a question that reaches past the rows is refused rather than answered short.
 */
export const RAW_COLLECTION_DAYS = 14;

export function pruneSourceTraffic(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - METRIC_DAYS * 86_400_000).toISOString().slice(0, 10);
  try {
    return db
      .query<{ removed: number }, [string]>("DELETE FROM source_traffic_days WHERE day < ? RETURNING 1 AS removed")
      .all(cutoff).length;
  } catch {
    log("warn", "Source traffic retention cleanup failed");
    return 0;
  }
}

export function pruneSourceCollectionMetrics(db: Database, now = Date.now()): number {
  const failureCutoff = new Date(now - RAW_COLLECTION_DAYS * 24 * 3_600_000).toISOString();
  const repairCutoff = `${new Date(now - (REFOLD_DAYS - 1) * 24 * 3_600_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
  let removed = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    try {
      // Chunked like the snapshots above: the first run after this ships has a six-figure backlog
      // to clear, and one statement for all of it holds a write lock for the length of it.
      //
      // Keep every row in the repair window, and the latest five attempts even for a quiet source.
      // Older successes need only their fold; failures still need their minute and sentence.
      // Match the fold's source AND outcome: another source having a row on that day proves nothing.
      const deleted = db
        .query<{ removed: number }, [string, string, number, number]>(
          // By the key, not by `rowid`: migration 076 made (source, collected_at) the table, so
          // there is no rowid to delete by. The statement is in `HOT_WRITES` for the same reason.
          `DELETE FROM source_collection_metrics WHERE (source, collected_at) IN (
             SELECT m.source, m.collected_at FROM source_collection_metrics m
             WHERE m.collected_at < ? AND (m.success = 1 OR m.collected_at < ?)
               AND m.collected_at < (
                 SELECT collected_at FROM source_collection_metrics latest
                 WHERE latest.source = m.source ORDER BY collected_at DESC LIMIT 1 OFFSET ?
               )
               AND EXISTS (
                 SELECT 1 FROM source_collection_days d
                 WHERE d.day = substr(m.collected_at, 1, 10) AND d.source = m.source
                   AND d.outcome = CASE WHEN m.success = 1 THEN 'success' ELSE ${FAILURE_KIND} END
               )
             LIMIT ?
           ) RETURNING 1 AS removed`,
        )
        .all(repairCutoff, failureCutoff, LATEST_COLLECTIONS - 1, CHUNK * 20).length;
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

/** Where growth stops being normal and becomes something to look at, rather than to discover. */
export const DATABASE_SIZE_BUDGET = 5 * 1024 ** 3;

/**
 * What the database occupies, in the file and beside it.
 *
 * `walBytes` is part of the answer rather than a separate question because leaving it out is a
 * mistake this has already made: the size alert compared the file's page count to the budget, and
 * on 2026-10-03 a VACUUM wrote the whole rebuild through the log and left 258 MB of write-ahead
 * beside a 252 MB file. Half a gigabyte on disk, and nothing warned, because the half that grew was
 * the half nothing measured. A caller that wants the file alone can still take `bytes`; a caller
 * that wants to know what the disk is holding cannot now forget that the log is on it.
 */
export function databaseSize(db: Database): { bytes: number; snapshotBytes: number; walBytes: number | null } {
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const snapshotBytes =
    db.query<{ total: number | null }, []>("SELECT SUM(LENGTH(body)) AS total FROM snapshots").get()?.total ?? 0;
  return { bytes: pages * pageSize, snapshotBytes, walBytes: walBytes(db) };
}

/**
 * The write-ahead log beside the file, which is disk the file's own page count does not show.
 *
 * `null` means there is no log file: a database that has never been written in WAL mode, or an
 * in-memory one. That is not the same as a log of zero bytes, which is what a checkpoint leaves.
 */
export function walBytes(db: Database): number | null {
  const file = db.query<{ file: string }, []>("PRAGMA database_list").get()?.file;
  if (!file) return null;
  return statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? null;
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

/**
 * How long the structure of a failure is kept.
 *
 * `recordFailureEvidence` already caps the rows per source, so this is not about volume: it is about
 * a source that was retired six months ago still answering for itself in a report. Ninety days
 * matches `source_collection_metrics`, which is what the rates beside it are read from.
 */
const FAILURE_EVIDENCE_LIFETIME_DAYS = 90;

export function pruneFailureEvidence(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - FAILURE_EVIDENCE_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  try {
    return db
      .query<{ removed: number }, [string]>(
        "DELETE FROM source_failure_evidence WHERE observed_at < ? RETURNING 1 AS removed",
      )
      .all(cutoff).length;
  } catch (error) {
    log("warn", "Failure evidence retention cleanup failed", {
      errorType: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
}

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

/**
 * How long a shape nobody has seen since is kept.
 *
 * `recordSourceShape` caps the rows per source, so this is about a contract that stopped being the
 * contract: a shape last seen six months ago is not what this source answers with, and holding it
 * makes the diff in `failures` a comparison against history rather than against last week.
 */
const SOURCE_SHAPE_LIFETIME_DAYS = 90;

export function pruneSourceShapes(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - SOURCE_SHAPE_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  try {
    return db
      .query<{ removed: number }, [string]>("DELETE FROM source_shapes WHERE last_seen_at < ? RETURNING 1 AS removed")
      .all(cutoff).length;
  } catch (error) {
    log("warn", "Source shape retention cleanup failed", {
      errorType: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
}

/**
 * Release fingerprints older than the deploys anybody still asks about.
 *
 * One row per boot, and a container that restarts unexpectedly writes one too. Forty is what
 * `verify` reads back to find the boot before this one; ninety days is generous beside that and
 * still bounded, which is the whole requirement for a 200-byte row.
 */
const RELEASE_RENDER_LIFETIME_DAYS = 90;

export function pruneReleaseRenders(db: Database, now = Date.now()): number {
  const cutoff = new Date(now - RELEASE_RENDER_LIFETIME_DAYS * 24 * 3_600_000).toISOString();
  try {
    return db
      .query<{ removed: number }, [string]>("DELETE FROM release_renders WHERE booted_at < ? RETURNING 1 AS removed")
      .all(cutoff).length;
  } catch (error) {
    log("warn", "Release render retention cleanup failed", {
      errorType: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
}
