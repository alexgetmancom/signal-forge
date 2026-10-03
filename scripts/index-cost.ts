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
import { indexUses, unexplained } from "./indexReaders.js";
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
 * What uses each index, and what it weighs.
 *
 * The "what uses it" half is `indexReaders.ts`, shared with `check-indexes`, which is the gate's
 * version of this question and the half that runs without `dbstat`. Keeping them as one module is
 * the point: two implementations of "is this index used" would disagree, and the one in the gate
 * would be the one nobody reads the output of.
 */
const indexes = indexUses(db)
  .map((use) => ({
    ...use,
    bytes: weights.get(use.index)?.bytes ?? 0,
    pages: weights.get(use.index)?.pages ?? 0,
  }))
  .sort((one, other) => other.bytes - one.bytes);

const tables = db
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((table) => ({ table: table.name, bytes: weights.get(table.name)?.bytes ?? 0 }))
  .sort((one, other) => other.bytes - one.bytes);

const indexBytes = indexes.reduce((total, index) => total + index.bytes, 0);
const tableBytes = tables.reduce((total, table) => total + table.bytes, 0);
// Weighed, not merely listed: `check-indexes` fails on an index nothing explains, so anything here
// has a recorded reason, and the number worth having is what those reasons cost.
const unread = unexplained(indexes).filter((index) => index.bytes > 0);
const report = {
  database: path,
  indexBytes,
  tableBytes,
  indexShare: Math.round((indexBytes / Math.max(indexBytes + tableBytes, 1)) * 1000) / 10,
  indexes,
  tables,
  // An index whose use the schema cannot derive. Each has a line in `check-indexes`' RECORD naming
  // the statement that reads it; what is missing is that statement's plan being checked, which is
  // what putting it in `hotQueries.ts` would buy. This is the price of that gap.
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
        `${
          index.hotStatements.length
            ? `\n              used by: ${index.hotStatements.join("; ")}`
            : index.unique
              ? "\n              enforces a UNIQUE constraint"
              : index.foreignKey
                ? `\n              backs ${index.foreignKey}`
                : "\n              nothing derives a use for it; see RECORD in check-indexes.ts"
        }`,
    ),
  ];
  if (unread.length)
    lines.push(
      "",
      `${unread.length} declared ${unread.length === 1 ? "index" : "indexes"} with a recorded reader rather than a checked one, ` +
        `${megabytes(unread.reduce((total, index) => total + index.bytes, 0))} MB: ` +
        unread.map((index) => index.index).join(", "),
      "Each has a line in check-indexes.ts naming what reads it, and no plan checked against it. Moving that",
      "statement into src/storage/hotQueries.ts is what closes the gap, and shortens RECORD in the same move.",
    );
  process.stdout.write(`${lines.join("\n")}\n`);
}

db.close();
