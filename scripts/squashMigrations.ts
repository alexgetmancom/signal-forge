/**
 * What a journal of migrations amounts to, written as one file that produces the same schema.
 *
 * A journal only ever grows: every table, column and index this service gained is a file, and every
 * new database and every test replays all of them, each in a transaction of its own, to arrive at
 * a shape no database was ever going to start from again. Production, meanwhile, has run them once
 * and never will again. So once a version is deployed, the files up to it are history, and history
 * lives in the git log. Doing that by hand once took an afternoon, most of it spent proving that the
 * file written by hand was the same schema; this does the writing and the proving.
 *
 * It does not trust itself. The old journal is replayed through the same runner a deployment uses,
 * the new one is replayed beside it, and the file is not offered unless the two schemas agree on
 * every table, column, default, constraint, foreign key, index, view and trigger. It also refuses
 * the one thing a schema dump cannot carry and would lose without saying so: rows a migration
 * inserted.
 */
import type { Database } from "bun:sqlite";
import { openWithoutMigrating } from "../src/storage/database.js";
import { applyMigrations } from "../src/storage/migrationRunner.js";
import type { Migration } from "../src/storage/migrations.js";

export type Squash = {
  /** The file to write, numbered for the version it produces. */
  filename: string;
  sql: string;
  /** The files it replaces, the previous baseline included. */
  replaces: Migration[];
  /** Migrations above the squashed version, which stay as they are. */
  kept: Migration[];
};

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

/** A deployment's own replay of a journal: the same pragmas, the same runner, nothing else. */
function replay(journal: readonly Migration[]): Database {
  const db = openWithoutMigrating(":memory:");
  applyMigrations(db, journal);
  return db;
}

/** Everything with a definition of its own. Indexes SQLite makes for a UNIQUE are not objects here. */
function schemaObjects(db: Database): SchemaObject[] {
  return db
    .query<SchemaObject, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid",
    )
    .all();
}

const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Where a `--` comment begins on a line, outside a quoted string, or -1. */
function commentStart(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "'") quoted = !quoted;
    else if (!quoted && line[index] === "-" && line[index + 1] === "-") return index;
  }
  return -1;
}

function withoutComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (commentStart(line) < 0 ? line : line.slice(0, commentStart(line))))
    .join("\n");
}

/**
 * A baseline carries a schema and nothing else, so a row a migration inserted is refused rather
 * than dropped: it would not be in the new database, and nothing in the file would say it was
 * missing. Whether it matters is for a person to decide.
 */
function refuseRows(db: Database, objects: readonly SchemaObject[]): void {
  for (const table of objects.filter((object) => object.type === "table")) {
    const rows = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${identifier(table.name)}`).get()?.n ?? 0;
    if (rows)
      throw new Error(`The journal leaves ${rows} rows in ${table.name}; a baseline carries the schema, not data`);
  }
}

type Cell = { character: string; index: number; depth: number; code: boolean };

/**
 * Each character of a statement with the depth of parentheses it leaves behind, and whether it is
 * code rather than the inside of a string or a comment. Every other function here that has to find
 * a comma or a closing parenthesis asks this, so that none of them can be fooled by one in a
 * `CHECK(x IN ('a,b'))` or a remark.
 */
function walk(text: string): Cell[] {
  const cells: Cell[] = [];
  let depth = 0;
  let quoted = false;
  let commented = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? "";
    let code = false;
    if (commented) commented = character !== "\n";
    else if (quoted) quoted = character !== "'";
    else if (character === "'") quoted = true;
    else if (character === "-" && text[index + 1] === "-") commented = true;
    else {
      code = true;
      if (character === "(") depth++;
      if (character === ")") depth--;
    }
    cells.push({ character, index, depth, code });
  }
  return cells;
}

/** One table, one column or constraint to a line, with the comments that were inside it kept. */
function layOutTable(original: string): string {
  // A block comment on a line of its own becomes the `--` the rest of the schema speaks in.
  const sql = original.replace(/^[ \t]*\/\*\*?\s*(.*?)\s*\*\/[ \t]*$/gm, "  -- $1");
  if (sql.includes("/*")) throw new Error(`A table definition has a comment this cannot lay out:\n${sql}`);
  const cells = walk(sql);
  const open = cells.find((cell) => cell.code && cell.character === "(")?.index ?? -1;
  const close = cells.find((cell) => cell.code && cell.character === ")" && cell.depth === 0)?.index ?? -1;
  if (open < 0 || close < open) throw new Error(`No column list in:\n${sql}`);
  // The commas at depth one are the ones between a table's columns and constraints.
  const items = [""];
  for (const cell of cells.slice(open + 1, close)) {
    if (cell.code && cell.character === "," && cell.depth === 1) items.push("");
    else items[items.length - 1] += cell.character;
  }
  const lines = items.flatMap(layOutItem);
  // The last column carries no comma, and a remark made after it has none to lose.
  let last = lines.length - 1;
  while (last > 0 && lines[last]?.trim().startsWith("--")) last--;
  lines[last] = (lines[last] ?? "").replace(/,$/, "");
  const head = sql.slice(0, open).replace(/\s+/g, " ").replaceAll('"', "").trim();
  const tail = sql.slice(close + 1).trim();
  return `${head} (\n${lines.join("\n")}\n)${tail ? ` ${tail}` : ""};`;
}

/** A column or constraint on one line, preceded by whatever remarks were made about it. */
function layOutItem(item: string): string[] {
  const remarks: string[] = [];
  const code: string[] = [];
  for (const row of item.split("\n").map((line) => line.trim())) {
    const at = commentStart(row);
    if (at >= 0) remarks.push(`  ${row.slice(at).trim()}`);
    if (at !== 0 && row) code.push(at < 0 ? row : row.slice(0, at).trim());
  }
  const text = code.join(" ").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
  return text ? [...remarks, `  ${text},`] : remarks;
}

function layOutIndex(sql: string): string {
  // Collapsing a statement onto one line would turn everything after a comment into part of it.
  if (sql.includes("--") || sql.includes("/*")) return `${sql.trim()};`;
  return `${sql.replaceAll('"', "").replace(/\s+/g, " ").trim()};`;
}

/** Parents before the tables that point at them, and among equals the order they already had. */
function inCreationOrder(tables: readonly SchemaObject[], earlier: readonly string[]): SchemaObject[] {
  const rank = (table: SchemaObject): number => {
    const known = earlier.indexOf(table.name);
    return known >= 0 ? known : earlier.length + tables.indexOf(table);
  };
  const parents = (table: SchemaObject): string[] =>
    [...table.sql.matchAll(/REFERENCES\s+"?(\w+)"?/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => name !== table.name);
  const names = new Set(tables.map((table) => table.name));
  const ordered: SchemaObject[] = [];
  const placed = new Set<string>();
  const waiting = [...tables].sort((left, right) => rank(left) - rank(right));
  while (waiting.length) {
    const ready = waiting.findIndex((table) => parents(table).every((name) => placed.has(name) || !names.has(name)));
    if (ready < 0)
      throw new Error(`Tables reference each other in a cycle: ${waiting.map((table) => table.name).join(", ")}`);
    const [table] = waiting.splice(ready, 1);
    if (table) {
      ordered.push(table);
      placed.add(table.name);
    }
  }
  return ordered;
}

const padded = (version: number): string => String(version).padStart(3, "0");

function header(first: number, through: number, files: number): string {
  return `-- The whole schema, as one statement list.
--
-- Migrations ${padded(first)} to ${padded(through)} were squashed into this file once production had reached the end of that
-- journal. ${files} files were replayed by every new database and every test, each in a transaction of its
-- own with a foreign-key check after it, to arrive at a shape no database was ever going to start from
-- again. What they did and why is in the git log; the numbers that comments elsewhere give ("migration
-- 059", "see 062") are the numbers of that journal.
--
-- It is numbered ${padded(through)} because that is the version it produces. Production already holds that
-- version and so has nothing to run; a new database runs this one file and arrives there directly.
-- An archive older than the squash carries a lower version, and this file cannot walk it forward:
-- check it out at the commit before the squash, migrate it there, and come back. The runner says so
-- rather than failing on the first table that already exists.
--
-- Tables come parents first. Timestamps are UTC ISO-8601 strings with millisecond precision, and the
-- GLOB check on each timestamp column is what enforces that.

`;
}

const STATISTICS = `
-- Statistics for the planner: without sqlite_stat1 it ignores an index it has not been told is
-- selective (see src/storage/hotQueries.ts). A new database is empty, so this creates the table that
-- \`PRAGMA optimize\` keeps current afterwards.
ANALYZE;
`;

/** Every observable property of a schema, one entry per object, so a mismatch can name the object. */
function fingerprint(db: Database): Map<string, string> {
  const result = new Map<string, string>();
  for (const object of schemaObjects(db)) {
    const parts = [withoutComments(object.sql).replace(/["`\s]/g, "")];
    const name = identifier(object.name);
    if (object.type === "table")
      parts.push(
        JSON.stringify(db.query(`PRAGMA table_xinfo(${name})`).all()),
        JSON.stringify(db.query(`PRAGMA foreign_key_list(${name})`).all()),
      );
    if (object.type === "index") parts.push(JSON.stringify(db.query(`PRAGMA index_xinfo(${name})`).all()));
    result.set(`${object.type} ${object.name}`, parts.join("\n"));
  }
  return result;
}

function disagreement(expected: Map<string, string>, actual: Map<string, string>): string[] {
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .filter((key) => expected.get(key) !== actual.get(key))
    .map((key) => (!expected.has(key) ? `${key} is new` : !actual.has(key) ? `${key} is missing` : `${key} differs`));
}

/**
 * The journal up to `through`, as one file, and the proof that it is the same schema.
 *
 * `through` is a version production already holds: squashing past it would fold a migration that
 * has never run there into a file production is told it has no need of.
 */
export function squash(journal: readonly Migration[], through: number): Squash {
  const first = journal[0];
  if (!first || !journal.some((migration) => migration.version === through))
    throw new Error(`The journal has no migration ${through}`);
  const replaces = journal.filter((migration) => migration.version <= through);
  const kept = journal.filter((migration) => migration.version > through);
  if (replaces.length < 2) throw new Error(`Nothing to squash: ${through} is already the baseline`);

  const built = replay(replaces);
  const objects = schemaObjects(built);
  refuseRows(built, objects);
  const earlier = [...first.sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((match) => match[1] ?? "");
  const blocks = inCreationOrder(
    objects.filter((object) => object.type === "table"),
    earlier,
  ).map((table) =>
    [
      layOutTable(table.sql),
      ...objects
        .filter((object) => object.type === "index" && object.tbl_name === table.name)
        .map((i) => layOutIndex(i.sql)),
    ].join("\n"),
  );
  // Views and triggers read the tables, so they come after all of them, in the order they were made.
  const readers = objects.filter((object) => object.type === "view" || object.type === "trigger");
  if (readers.length)
    blocks.push(
      `-- Views and triggers, which read the tables above.\n${readers.map((one) => `${one.sql.trim()};`).join("\n\n")}`,
    );
  const filename = `${padded(through)}_baseline.sql`;
  const sql = `${header(first.version, through, replaces.length)}${blocks.join("\n\n")}\n${STATISTICS}`;

  // The proof: the whole old journal against the new file with whatever stays above it.
  const squashed: Migration = { version: through, name: "baseline", filename, sql };
  const wrong = disagreement(fingerprint(replay(journal)), fingerprint(replay([squashed, ...kept])));
  if (wrong.length) throw new Error(`The squashed file is not the same schema: ${wrong.join("; ")}`);
  return { filename, sql, replaces, kept };
}
