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
 * `bodies` is payload and `tables` is pages, and the second was added because the first could not
 * answer the question it was built for. `bodies` names four tables, so everything else in the file
 * landed in `unaccountedBytes` -- 115 MB of a 252 MB database on 2026-10-03, 46% of it, and the
 * largest single thing in there was a table the report had no way to mention. Finding it meant
 * querying `dbstat` by hand. `tables` is that query: every b-tree in the file, its own indexes
 * counted beside it, so the remainder is page overhead and nothing else.
 */
export type StorageReport = {
  file: { bytes: number; freeBytes: number; walBytes: number | null; budgetBytes: number };
  /** Payload bytes by table, largest first. Snapshots and HTTP cache are counted as stored, gzipped. */
  bodies: { table: BodyTable; rows: number; bytes: number }[];
  /** Every table in the file, largest first, with what its own indexes cost beside it. */
  tables: { table: string; bytes: number; indexBytes: number; rows: number | null }[];
  /** Page overhead the tables above do not account for. A remainder, and now a small one. */
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

type BodyTable = "events" | "records" | "snapshots" | "http_cache";

export function storageReport(db: Database, options: { days: number; top: number; now?: Date }): StorageReport {
  const now = options.now ?? new Date();
  const size = databaseSize(db);
  const freePages = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const bodies = bodiesOf(db);
  const tables = tablesOf(db);
  const paged = tables.reduce((total, table) => total + table.bytes + table.indexBytes, 0);
  const freeBytes = freePages * pageSize;
  return {
    file: { bytes: size.bytes, freeBytes, walBytes: size.walBytes, budgetBytes: DATABASE_SIZE_BUDGET },
    bodies,
    tables,
    unaccountedBytes: Math.max(0, size.bytes - freeBytes - paged),
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
    one("http_cache", "SELECT COUNT(*) n, SUM(LENGTH(body)) b FROM http_cache"),
  ].sort((one, other) => other.bytes - one.bytes);
}

/**
 * Every b-tree in the file, from `dbstat`, with each index charged to the table it indexes.
 *
 * `aggregate=TRUE` returns one row per b-tree instead of one per page: 114 rows rather than sixty
 * thousand. It still walks the trees, so it is not free -- measured at 251 ms and 11 MB of
 * high-water on a 252 MB copy of production, and nothing on a second call. That is cheaper than one
 * ordinary collection, which is the bar a read answered inside the long-lived service has to clear.
 *
 * Row counts come from `sqlite_stat1`, which `ANALYZE` wrote, rather than from 114 `COUNT(*)`
 * statements. That makes them an estimate as of the last `ANALYZE`, and `null` for a table no
 * `ANALYZE` has reached; a count that is exact is not worth scanning every table to print.
 */
function tablesOf(db: Database): StorageReport["tables"] {
  const owner = new Map(
    db
      .query<{ name: string; tbl_name: string }, []>("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => [row.name, row.tbl_name] as const),
  );
  const rows = new Map(
    db
      .query<{ tbl: string; stat: string }, []>("SELECT tbl, stat FROM sqlite_stat1")
      .all()
      .map((row) => [row.tbl, Number.parseInt(row.stat.split(" ")[0] ?? "", 10)] as const),
  );
  const totals = new Map<string, { bytes: number; indexBytes: number }>();
  for (const btree of db
    .query<{ name: string; b: number }, []>("SELECT name, SUM(pgsize) b FROM dbstat WHERE aggregate=TRUE GROUP BY name")
    .all()) {
    // An autoindex is a WITHOUT ROWID table's own storage, or a UNIQUE constraint's index, and
    // `sqlite_master` has no row for either; the owner is in the name. Everything else is a table.
    const auto = autoindexOwner(btree.name);
    const table = owner.get(btree.name) ?? auto ?? btree.name;
    const asIndex = owner.has(btree.name) || auto !== null;
    const total = totals.get(table) ?? { bytes: 0, indexBytes: 0 };
    if (asIndex) total.indexBytes += btree.b;
    else total.bytes += btree.b;
    totals.set(table, total);
  }
  return [...totals]
    .map(([table, total]) => ({ table, ...total, rows: rows.get(table) ?? null }))
    .sort((one, other) => other.bytes + other.indexBytes - (one.bytes + one.indexBytes));
}

/** The table a `sqlite_autoindex_<table>_<n>` belongs to, or null when the name is not one. */
function autoindexOwner(name: string): string | null {
  return /^sqlite_autoindex_(.+)_\d+$/.exec(name)?.[1] ?? null;
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
