/**
 * Every table and column this repository names in SQL exists.
 *
 * 477 statements in 48 files outside `src/storage/` spell table and column names as string
 * literals, which the compiler reads as text. Three names were guessed wrong in one week --
 * `operator_journal.at` for `recorded_at`, `source_collection_metrics.ok` for `success`,
 * `total_ms` for `total_duration_ms` -- and one of them reached production, where a broken read
 * is an empty report rather than a crash.
 *
 * The check does not parse SQL. It builds the real schema from the migrations in memory and asks
 * SQLite to prepare each statement, which is the same parser that will run it. A statement SQLite
 * cannot parse at all is counted and skipped: those are the ones assembled from interpolated
 * fragments, where the text in the file is not the text that runs. A statement it parses but whose
 * names it cannot resolve is the bug this exists to catch.
 *
 * `scripts/` is not scanned yet. Pointing this at it finds one thing, and it is not a typo:
 * `scripts/compress-snapshots.ts` still reads `snapshots.raw_json`, a column migration 026 dropped
 * once the backfill it was written for had run. The script cannot work against any database that
 * exists. Delete it and this can read `scripts/` too.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { readMigrations, splitStatements } from "../src/storage/migrations.js";
import { literals, STARTS } from "./sqlLiterals.js";

const root = resolve(import.meta.dir, "..");
const roots = ["src"];

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && extname(entry.name) === ".ts") result.push(path);
  }
  return result;
}

/** A statement, as it is written, and where. */
type Statement = { file: string; line: number; sql: string };

const db = new Database(":memory:");
for (const migration of readMigrations()) for (const statement of splitStatements(migration.sql)) db.exec(statement);

const statements: Statement[] = [];
for (const name of roots) {
  const directory = join(root, name);
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const file of walk(directory)) {
    const text = readFileSync(file, "utf8");
    for (const { line, value } of literals(text))
      if (STARTS.test(value)) statements.push({ file: relative(root, file), line, sql: value });
  }
}

const findings: string[] = [];
let unparsed = 0;
for (const statement of statements) {
  try {
    db.prepare(statement.sql).finalize();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A table or column named `?` is a fragment spliced in at run time, not a name that is wrong:
    // `database.ts` counts the rows of a table it is handed. Those are the assembled ones.
    if (/no such (?:table|column): \?$/i.test(message)) unparsed += 1;
    else if (/no such (?:table|column)/i.test(message))
      findings.push(`${statement.file}:${statement.line}: ${message} -- ${statement.sql.replace(/\s+/g, " ").trim()}`);
    else unparsed += 1;
  }
}

if (findings.length) {
  console.error(`SQL names nothing exists:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `SQL check passed: ${statements.length} statements name only tables and columns the migrations create` +
    `${unparsed ? ` (${unparsed} assembled at run time and not parsed)` : ""}.`,
);
