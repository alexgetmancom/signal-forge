import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { DATABASE_SIZE_BUDGET, databaseSize } from "../storage/retention.js";

/**
 * What the database file is made of, and which of it is growing.
 *
 * The size alert in `issues` says the file passed five gigabytes and tells whoever reads it to find
 * out which sources serve the largest payloads, and there was no command that said. The answer was
 * written by hand each time: four `SUM(LENGTH(...))` over four tables, which is how it was first
 * measured on 2026-10-02 -- 473 MB, of which compressed payloads were 217 MB, the HTTP cache 66 MB,
 * event bodies 47 MB and record bodies 14 MB, with the rest in indexes and every other table.
 *
 * A body is the part that grows. The row counts `schema` gives are not it: 340 thousand collection
 * metrics weigh less than seventeen thousand events, because a metric is a few numbers and an event
 * carries what a record said before and after.
 *
 * Nothing here reads a body: SQLite sums the lengths and one number comes back. Page and index
 * overhead are not in `bodies`, so `unaccountedBytes` is what the file holds besides them -- indexes,
 * every smaller table, and the overhead -- not a measurement of any one thing.
 */
export type StorageReport = {
  file: { bytes: number; freeBytes: number; walBytes: number | null; budgetBytes: number };
  /** Payload bytes by table, largest first. Snapshots are counted as stored, which is gzipped. */
  bodies: { table: BodyTable; rows: number; bytes: number }[];
  unaccountedBytes: number;
  snapshots: {
    rows: number;
    /** Rows whose payload retention has already released: a receipt, no bytes. */
    expiredRows: number;
    /** The sources holding the most stored payload, and what share of all of it they hold. */
    topShare: number;
    bySource: { source: string; rows: number; keptRows: number; bytes: number; avgBytes: number; newestAt: string }[];
  };
  events: {
    windowDays: number;
    days: { day: string; events: number; bytes: number }[];
    /** The complete days of the window, extrapolated. An average of what happened, not a forecast. */
    pace: { eventsPerDay: number; bytesPerDay: number; basisDays: number } | null;
  };
};

type BodyTable = "events" | "records" | "snapshots" | "http_cache";

export function storageReport(db: Database, options: { days: number; top: number; now?: Date }): StorageReport {
  const now = options.now ?? new Date();
  const size = databaseSize(db);
  const freePages = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const bodies = bodiesOf(db);
  const held = bodies.reduce((total, body) => total + body.bytes, 0);
  const freeBytes = freePages * pageSize;
  return {
    file: { bytes: size.bytes, freeBytes, walBytes: walBytes(db), budgetBytes: DATABASE_SIZE_BUDGET },
    bodies,
    unaccountedBytes: Math.max(0, size.bytes - freeBytes - held),
    snapshots: snapshotsOf(db, options.top),
    events: eventsOf(db, options.days, now),
  };
}

function bodiesOf(db: Database): StorageReport["bodies"] {
  const one = (table: BodyTable, sql: string): StorageReport["bodies"][number] => {
    const row = db.query<{ n: number; b: number | null }, []>(sql).get();
    return { table, rows: row?.n ?? 0, bytes: row?.b ?? 0 };
  };
  return [
    // `CAST ... AS BLOB` is the length in bytes of a text value, which is what it occupies, and is
    // written out in each statement rather than assembled: `check-sql` can only vouch for a column
    // name it can read, and a wrong one here would be a report that says nothing weighs anything.
    one(
      "events",
      "SELECT COUNT(*) n, SUM(LENGTH(CAST(COALESCE(before_json,'') AS BLOB))+LENGTH(CAST(COALESCE(after_json,'') AS BLOB))) b FROM events",
    ),
    one(
      "records",
      "SELECT COUNT(*) n, SUM(LENGTH(CAST(body AS BLOB))+LENGTH(CAST(COALESCE(candidate_body,'') AS BLOB))) b FROM records",
    ),
    // A blob's length is in its header, so this does not read a megabyte to count one.
    one("snapshots", "SELECT COUNT(*) n, SUM(LENGTH(body)) b FROM snapshots"),
    one("http_cache", "SELECT COUNT(*) n, SUM(LENGTH(CAST(body AS BLOB))) b FROM http_cache"),
  ].sort((one, other) => other.bytes - one.bytes);
}

function snapshotsOf(db: Database, top: number): StorageReport["snapshots"] {
  const total = db
    .query<{ n: number; kept: number | null; b: number | null }, []>(
      "SELECT COUNT(*) n, SUM(body IS NOT NULL) kept, SUM(LENGTH(body)) b FROM snapshots",
    )
    .get();
  const rows = db
    .query<{ source: string; n: number; kept: number; b: number; newest: string }, [number]>(
      `SELECT source, COUNT(*) n, SUM(body IS NOT NULL) kept, COALESCE(SUM(LENGTH(body)),0) b, MAX(collected_at) newest
       FROM snapshots GROUP BY source ORDER BY b DESC, source LIMIT ?`,
    )
    .all(top);
  const bytes = total?.b ?? 0;
  const held = rows.reduce((sum, row) => sum + row.b, 0);
  return {
    rows: total?.n ?? 0,
    expiredRows: (total?.n ?? 0) - (total?.kept ?? 0),
    topShare: bytes > 0 ? Math.round((held / bytes) * 1000) / 1000 : 0,
    bySource: rows.map((row) => ({
      source: row.source,
      rows: row.n,
      keptRows: row.kept,
      bytes: row.b,
      avgBytes: row.kept > 0 ? Math.round(row.b / row.kept) : 0,
      newestAt: row.newest,
    })),
  };
}

function eventsOf(db: Database, days: number, now: Date): StorageReport["events"] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const perDay = db
    .query<{ day: string; n: number; b: number }, [string]>(
      `SELECT substr(detected_at,1,10) day, COUNT(*) n,
         SUM(LENGTH(CAST(COALESCE(before_json,'') AS BLOB))+LENGTH(CAST(COALESCE(after_json,'') AS BLOB))) b
       FROM events WHERE detected_at>=? GROUP BY day ORDER BY day`,
    )
    .all(since)
    .map((row) => ({ day: row.day, events: row.n, bytes: row.b }));
  return { windowDays: days, days: perDay, pace: paceOf(perDay, now.toISOString().slice(0, 10)) };
}

/**
 * Per-day averages over the days that are over. Today is half a day and would drag the average down
 * for every hour it has not finished; and a calendar day with no event is not in the grouped rows,
 * so the divisor is the span from the first day seen to yesterday, not the number of rows.
 */
function paceOf(days: StorageReport["events"]["days"], today: string): StorageReport["events"]["pace"] {
  const complete = days.filter((row) => row.day < today);
  const first = complete[0];
  if (!first) return null;
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first.day}T00:00:00Z`)) / 86_400_000);
  const events = complete.reduce((sum, row) => sum + row.events, 0);
  const bytes = complete.reduce((sum, row) => sum + row.bytes, 0);
  return { eventsPerDay: Math.round(events / span), bytesPerDay: Math.round(bytes / span), basisDays: span };
}

/** The write-ahead log beside the file, which is where a burst of large writes is felt first. */
function walBytes(db: Database): number | null {
  const file = db.query<{ file: string }, []>("PRAGMA database_list").get()?.file;
  if (!file) return null;
  return statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? null;
}
