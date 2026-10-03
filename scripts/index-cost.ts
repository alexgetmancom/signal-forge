/**
 * What each index costs, and which hot read it exists for.
 *
 * `storage` reports the file, the free pages and the weight of every table, and the difference
 * between them is one number called `unaccountedBytes` -- 40.6 MB of the 225.6 MB on production,
 * and almost all of it indexes. It cannot say more than that, because per-index bytes come from
 * `dbstat` and production's SQLite is built without it. Checked in the container: `sqlite_master`,
 * `pragma_table_info`, `pragma_index_info` and `json_each` all answer there, and `dbstat` is
 * `no such table`.
 *
 * So the question is asked here instead, of a copy, by the SQLite on this machine, which has it.
 * That is also why this is a development command rather than an entry in `src/operations/`: an
 * operation is a question the service can answer, and the service cannot answer this one.
 *
 * The second half is the part worth having. An index is paid for on every write of its table and
 * read back only if the planner reaches for it, and from the outside an index nothing uses looks
 * exactly like an index that is holding the service up. This runs `EXPLAIN QUERY PLAN` over
 * src/storage/hotQueries.ts and says, per index, which of those reads names it -- so an index with
 * a size and no reader is a line of output rather than an afternoon of reading code.
 *
 * `source_collection_metrics_source_time` was 14.1 MB and the largest index in the database when
 * this was written, on a table kept fourteen days whose every count is read from the fold beside
 * it. That is the shape this is for finding.
 *
 * Reads only. Usage: bun run index-cost [--fresh] [--json]
 */
import { readonlyDatabase } from "../src/storage/database.js";
import { HOT_QUERIES } from "../src/storage/hotQueries.js";
import { prodCopy } from "./prodCopy.js";

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

const path = await prodCopy(Bun.argv.includes("--fresh"), say);
if (path === null) {
  say("Could not copy the database, and the local one is stale. An index size read from it is a number about June.");
  process.exit(1);
}

const db = readonlyDatabase(path);

let hasDbstat = true;
try {
  db.query<{ n: number }, []>("SELECT count(*) AS n FROM dbstat").get();
} catch {
  hasDbstat = false;
}
if (!hasDbstat) {
  say(
    "This SQLite has no `dbstat`, which is the only per-index size there is. " +
      "Bun on macOS has it; the Linux builds, including the one in the release image, do not.",
  );
  process.exit(1);
}

/** Bytes and pages per b-tree, which is one per table and one per index. */
const weights = new Map(
  db
    .query<{ name: string; bytes: number; pages: number }, []>(
      "SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name",
    )
    .all()
    .map((row) => [row.name, { bytes: row.bytes, pages: row.pages }] as const),
);

/**
 * Which hot reads name which index.
 *
 * The plan line is the only honest source: an index can be declared over the columns a read
 * filters on and still be ignored, which is what `ANALYZE` decides. `USING INTEGER PRIMARY KEY` is
 * not an index in `sqlite_master` and is not counted; a `WITHOUT ROWID` table's primary key is the
 * table itself and shows up as the table's own name, which is why a read of one appears here
 * against no index at all.
 */
const readersOf = new Map<string, string[]>();
for (const query of HOT_QUERIES) {
  let plan = "";
  try {
    const statement = db.prepare<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${query.sql}`);
    plan = statement
      .all(...query.params)
      .map((row) => row.detail)
      .join(" | ");
    statement.finalize();
  } catch {
    continue;
  }
  for (const match of plan.matchAll(/USING (?:COVERING )?INDEX ([A-Za-z_][\w]*)/g)) {
    const name = match[1] as string;
    if (!readersOf.has(name)) readersOf.set(name, []);
    (readersOf.get(name) as string[]).push(query.name);
  }
}

const indexes = db
  .query<{ name: string; tbl_name: string; sql: string | null }, []>(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name",
  )
  .all()
  .map((index) => ({
    index: index.name,
    table: index.tbl_name,
    // An autoindex has no `sql`: SQLite created it for a UNIQUE or a non-INTEGER PRIMARY KEY, and
    // dropping it means changing the constraint that asked for it.
    declared: index.sql !== null,
    columns: db
      .query<{ name: string | null }, [string]>("SELECT name FROM pragma_index_info(?)")
      .all(index.name)
      .map((column) => column.name ?? "<expression>"),
    bytes: weights.get(index.name)?.bytes ?? 0,
    pages: weights.get(index.name)?.pages ?? 0,
    hotReads: readersOf.get(index.name) ?? [],
  }))
  .sort((one, other) => other.bytes - one.bytes);

const tables = db
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((table) => ({ table: table.name, bytes: weights.get(table.name)?.bytes ?? 0 }))
  .sort((one, other) => other.bytes - one.bytes);

const indexBytes = indexes.reduce((total, index) => total + index.bytes, 0);
const tableBytes = tables.reduce((total, table) => total + table.bytes, 0);
const unread = indexes.filter((index) => index.declared && index.hotReads.length === 0 && index.bytes > 0);
const report = {
  database: path,
  indexBytes,
  tableBytes,
  indexShare: Math.round((indexBytes / Math.max(indexBytes + tableBytes, 1)) * 1000) / 10,
  indexes,
  tables,
  // An index declared by a migration that no hot read reaches for. Not a verdict: a read that is
  // not hot is still a read, and `src/` is the place to check before dropping one. It is the list
  // worth checking, which is what was missing.
  declaredWithNoHotRead: unread.map((index) => ({ index: index.index, table: index.table, bytes: index.bytes })),
};

function megabytes(bytes: number): string {
  return (bytes / 1024 ** 2).toFixed(1);
}

if (Bun.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `${megabytes(indexBytes)} MB of indexes against ${megabytes(tableBytes)} MB of tables (${report.indexShare}% of the pages)`,
    "",
    ...indexes.map(
      (index) =>
        `${megabytes(index.bytes).padStart(7)} MB  ${index.index}  (${index.table}: ${index.columns.join(", ")})` +
        `${index.declared ? "" : "  [autoindex]"}` +
        `${index.hotReads.length ? `\n              read by: ${index.hotReads.join("; ")}` : "\n              no hot read names it"}`,
    ),
  ];
  if (unread.length)
    lines.push(
      "",
      `${unread.length} declared ${unread.length === 1 ? "index" : "indexes"} no hot read names, ` +
        `${megabytes(unread.reduce((total, index) => total + index.bytes, 0))} MB: ` +
        unread.map((index) => index.index).join(", "),
      "Each is paid for on every write of its table. Check src/ for the read it was for, and if there is one,",
      "it belongs in src/storage/hotQueries.ts -- which is the rule a new index already ships under.",
    );
  process.stdout.write(`${lines.join("\n")}\n`);
}

db.close();
