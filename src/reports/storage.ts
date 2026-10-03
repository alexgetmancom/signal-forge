import type { Database } from "bun:sqlite";
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
 * Nothing here reads a body: SQLite sums the lengths and one number comes back.
 *
 * `tables` weighs every table, which it did not always do. It weighed four -- the ones that carry
 * bodies -- and everything else in the file landed in `unaccountedBytes`: 115 MB of a 252 MB
 * database on 2026-10-03, 46% of it, and the largest single thing in there was `code_metrics`, a
 * table this report had no way to mention. Finding it took a hand-written query.
 *
 * So the four are generated from the schema instead of listed, and the remainder is indexes and
 * page overhead rather than tables. Per-index bytes would need `dbstat`, which this cannot use:
 * production's Bun is built without it, and the only reason I know that is that the gate refused
 * the query on Linux after it had worked all afternoon on a Mac. A report that names every table
 * and cannot apportion the indexes is the honest version of the one that was wanted.
 */
export type StorageReport = {
  file: { bytes: number; freeBytes: number; walBytes: number | null; budgetBytes: number };
  /**
   * Payload bytes of every table, largest first. Blobs are counted as stored, so the snapshots and
   * the HTTP cache are their gzipped size. `rows` is `ANALYZE`'s estimate, null where it has not run.
   */
  tables: { table: string; bytes: number; rows: number | null }[];
  /** The file less those and the free pages: indexes and page overhead. A remainder, not a measurement. */
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
    /**
     * The sources whose events weigh the most, largest first, which is the one breakdown that
     * explains a jump. 42 of 17,688 events held 26 MB of a 47 MB table on 2026-10-03 because two
     * web sources stored a whole page twice per change; `days` and `pace` showed the table growing
     * and could not say that. `snapshots` has had this since it was written.
     */
    bySource: { source: string; events: number; bytes: number; avgBytes: number }[];
    days: { day: string; events: number; bytes: number }[];
    /** The complete days of the window, extrapolated. An average of what happened, not a forecast. */
    pace: { eventsPerDay: number; bytesPerDay: number; basisDays: number } | null;
  };
};

export function storageReport(db: Database, options: { days: number; top: number; now?: Date }): StorageReport {
  const now = options.now ?? new Date();
  const size = databaseSize(db);
  const freePages = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const tables = tablesOf(db);
  const held = tables.reduce((total, table) => total + table.bytes, 0);
  const freeBytes = freePages * pageSize;
  return {
    file: { bytes: size.bytes, freeBytes, walBytes: size.walBytes, budgetBytes: DATABASE_SIZE_BUDGET },
    tables,
    unaccountedBytes: Math.max(0, size.bytes - freeBytes - held),
    snapshots: snapshotsOf(db, options.top),
    events: eventsOf(db, options.days, now),
  };
}

/**
 * Every table, weighed by summing the length of every column of every row.
 *
 * The statement is generated from `sqlite_master` and `pragma_table_info` rather than written out,
 * which is the opposite of what this file used to do: four statements, each naming its columns, so
 * that `check-sql` could vouch for every name. That bought a report which could not name the
 * largest table in the database. The names here come from the schema itself, so there is nothing to
 * get wrong and nothing to keep in step -- a table added by a migration is weighed by the next
 * call, and `check-sql` cannot read these statements because they do not exist until it runs.
 *
 * `CAST(... AS BLOB)` is the length in bytes of a text value, which is what it occupies. A blob's
 * length is in its header, so a 500 KB snapshot body is weighed without being read.
 *
 * Measured on a 252 MB copy of production: 45 tables, 261 ms, 16 MB of high-water once. That is the
 * same order as the `dbstat` version this replaced, and it runs where that one cannot.
 */
function tablesOf(db: Database): StorageReport["tables"] {
  const rows = new Map(
    db
      .query<{ tbl: string; stat: string }, []>("SELECT tbl, stat FROM sqlite_stat1")
      .all()
      .map((row) => [row.tbl, Number.parseInt(row.stat.split(" ")[0] ?? "", 10)] as const),
  );
  const names = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const weighed: StorageReport["tables"] = [];
  for (const { name } of names) {
    const columns = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(name);
    if (columns.length === 0) continue;
    const sum = columns.map((column) => `LENGTH(CAST(COALESCE("${column.name}",'') AS BLOB))`).join("+");
    // Quoted identifiers, out of the schema of the database being read: there is no value here that
    // came from anywhere but SQLite's own catalogue, which is the only reason this is built as text.
    const bytes = db.query<{ b: number | null }, []>(`SELECT SUM(${sum}) b FROM "${name}"`).get()?.b ?? 0;
    weighed.push({ table: name, bytes, rows: rows.get(name) ?? null });
  }
  return weighed.sort((one, other) => other.bytes - one.bytes);
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

/**
 * The window is whole days: it begins at midnight, `days` days before today's.
 *
 * It began `days` days before the instant of asking, which is mid-day, so the first bucket held only
 * the part of a day after that hour and the pace divided it as a whole one. On the first read of
 * production 14 days came out at 1.375 MB a day; with the half day left out it is 1.435, which is
 * 4% more. Today is the other incomplete bucket and `paceOf` leaves it out.
 */
function eventsOf(db: Database, days: number, now: Date): StorageReport["events"] {
  const today = now.toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString();
  const perDay = db
    .query<{ day: string; n: number; b: number }, [string]>(
      `SELECT substr(detected_at,1,10) day, COUNT(*) n,
         SUM(LENGTH(CAST(COALESCE(before_json,'') AS BLOB))+LENGTH(CAST(COALESCE(after_json,'') AS BLOB))) b
       FROM events WHERE detected_at>=? GROUP BY day ORDER BY day`,
    )
    .all(since)
    .map((row) => ({ day: row.day, events: row.n, bytes: row.b }));
  const bySource = db
    .query<{ source: string; n: number; b: number }, [string]>(
      `SELECT source, COUNT(*) n,
         SUM(LENGTH(CAST(COALESCE(before_json,'') AS BLOB))+LENGTH(CAST(COALESCE(after_json,'') AS BLOB))) b
       FROM events WHERE detected_at>=? GROUP BY source ORDER BY b DESC, source`,
    )
    .all(since)
    .map((row) => ({
      source: row.source,
      events: row.n,
      bytes: row.b,
      avgBytes: row.n > 0 ? Math.round(row.b / row.n) : 0,
    }));
  return { windowDays: days, bySource, days: perDay, pace: paceOf(perDay, today) };
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
