/**
 * What each index costs, and which hot read it exists for.
 *
 * `storage` reports the file, the free pages and the weight of every table, and the difference
 * between them is one number called `unaccountedBytes` -- 23.9 MB of the 171.6 MB on production.
 * This is what it is made of, and on 2026-10-03 the two halves were 10.9 MB of indexes and about
 * 13 MB of page slack: `dbstat` totalled the file exactly, 10.9 MB of indexes against 159.5 MB of
 * table b-trees, while `storage` reports a table as the sum of its column lengths -- 80.7 MB of
 * snapshot payload living in an 82.3 MB b-tree. Neither number is wrong; one counts bytes and the
 * other counts the pages they sit in. Per-index bytes come from `dbstat` and production's SQLite is
 * built without it. Checked in the container: `sqlite_master`, `pragma_table_info`,
 * `pragma_index_info` and `json_each` all answer there, and `dbstat` is `no such table`.
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
 * Reads only, apart from the notebook: what the index set was and what it weighed is appended to
 * `.rehearsal/ledger.json`, the same file a rehearsal writes its findings to. The fingerprint is
 * over the schema -- every index, its table, its columns and what explains it -- and deliberately
 * not over the bytes, which move with the data on every run and would make every comparison a
 * difference. So "the same index set as the run four commits ago" is a thing this can say, which
 * is the question "how many indexes do we have" actually being asked across a week. 25.6 MB over
 * 37 declared indexes with 16 unexplained became 10.9 MB over 34 with none in a single session,
 * and both of those numbers were only ever in a terminal.
 *
 * Usage: bun run index-cost [--fresh] [--json]
 */
import { resolve } from "node:path";
import { readonlyDatabase } from "../src/storage/database.js";
import { indexUses, unexplained } from "./indexReaders.js";
import { cacheDir, prodCopy } from "./prodCopy.js";
import { appendEntry, type Entry, type Finding, lastAgreement, readLedger } from "./rehearsalLedger.js";

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
  // An index no hot statement's plan names here. `check-indexes` asks the same thing of an empty
  // schema and can pass while this does not: the planner there has no statistics, so it reaches for
  // an index it abandons once the table has a real distribution in it. This is the stricter answer,
  // and the only one that needs a copy of production.
  declaredWithNoHotRead: unread.map((index) => ({ index: index.index, table: index.table, bytes: index.bytes })),
};

function megabytes(bytes: number): string {
  return (bytes / 1024 ** 2).toFixed(1);
}

/**
 * What explains each index, in one word, so the fingerprint moves when a reason does.
 *
 * An index that stops being named by a hot read and starts being named by a foreign key is the
 * same index with the same columns, and it is not the same situation: the gate would still pass,
 * and the thing that changed is exactly what this session spent its time on.
 */
function reason(index: (typeof indexes)[number]): string {
  if (index.hotStatements.length) return "statement";
  if (index.unique) return "unique";
  if (index.foreignKey) return "foreign-key";
  return "unexplained";
}

/**
 * The schema, not the data. Columns and reasons, one line per index, hashed in name order.
 *
 * Bytes are left out on purpose: they move every time production collects anything, so a
 * fingerprint over them says "different" on every run and the ledger's one trick -- this is the
 * answer from four commits ago -- stops working. The bytes go in the note instead, where they can
 * be read and compared by a human without pretending to be an identity.
 */
const fingerprint = new Bun.CryptoHasher("sha256")
  .update(
    indexes
      .map((index) => `${index.index}|${index.table}|${index.columns.join(",")}|${reason(index)}`)
      .sort()
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 12);
const declared = indexes.filter((index) => index.declared);
const finding: Finding = {
  phase: "indexes",
  verdict: "same",
  moved: unread.length,
  fingerprint,
  note:
    `${megabytes(indexBytes)} MB across ${declared.length} declared indexes ` +
    `(${report.indexShare}% of the pages), ${unread.length} unexplained`,
};
const ledgerPath = resolve(cacheDir, "ledger.json");
function git(...args: string[]): string {
  return Bun.spawnSync(["git", ...args])
    .stdout.toString()
    .trim();
}
const entry: Entry = {
  at: new Date().toISOString(),
  base: "",
  baseSha: "",
  head: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain") !== "",
  tree: null,
  findings: [finding],
};
const earlier = readLedger(ledgerPath)
  .flatMap((seen) => seen.findings)
  .filter((seen) => seen.phase === "indexes")
  .at(-1);
const agreement = lastAgreement(readLedger(ledgerPath), finding);
appendEntry(ledgerPath, entry);

if (Bun.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ...report, finding, previous: earlier ?? null }, null, 2)}\n`);
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
      `${unread.length} declared ${unread.length === 1 ? "index" : "indexes"} no statement reaches for on production's own rows, ` +
        `${megabytes(unread.reduce((total, index) => total + index.bytes, 0))} MB: ` +
        unread.map((index) => index.index).join(", "),
      "`check-indexes` passes on all of these, and the difference is the statistics rather than the schema: it plans",
      "against an empty database where `ANALYZE` has nothing to go on, and this plans against the real distribution.",
      "An index the planner drops once a table has rows in it is the more interesting answer of the two, and the only",
      "place it can be had -- so this is worth reading even when the gate is green. Whether that means the index or",
      "the statement is wrong is a judgement; `read-cost` says what the statement costs without it.",
    );
  lines.push("", `${finding.note}, fingerprint ${fingerprint}`);
  if (agreement) lines.push(`  ${agreement}`);
  else if (earlier) lines.push(`  moved from ${earlier.fingerprint ?? "?"}: ${earlier.note ?? "no note"}`);
  else lines.push("  first run recorded in .rehearsal/ledger.json; the next one has something to compare against");
  process.stdout.write(`${lines.join("\n")}\n`);
}

db.close();
