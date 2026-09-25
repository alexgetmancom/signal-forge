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
 * `tests/` is deliberately out. Pointed at it the check finds eleven things and every one of them
 * is a name written wrong on purpose, to assert that the error comes back -- `event_summaries`,
 * `snapshots.summary`, `a_table_no_command_reads`. A test that names a real column wrongly fails
 * the moment it runs, which is the difference: in `src/` a wrong name returns an empty report and
 * nobody is told anything.
 *
 * `scripts/` is read too. The first thing it found there was not a typo: `compress-snapshots.ts`
 * still read `snapshots.raw_json`, a column migration 026 dropped once the backfill that script was
 * written for had run, so it could not work against any database that exists. It is gone.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { readMigrations, splitStatements } from "../src/storage/migrations.js";
import { literals, STARTS, tablesNamed } from "./sqlLiterals.js";

const root = resolve(import.meta.dir, "..");
const roots = ["src", "scripts"];

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

/**
 * The second rule: a read of `sources` goes through the registry.
 *
 * `sources` keeps a row for every source that has ever run, and the registry is the list of the
 * ones still being asked. Eight rows on production belong to nothing -- four designarena boards
 * frozen on 2026-09-09, two feeds, two desktop apps -- and a report that reads the table without
 * the registry counts them. It does not fail; it answers, and the answer names a collector that
 * was retired on purpose as one that is broken. `release.ts` counted them in the number that
 * decides whether a deploy is healthy, and would have gone on doing it until one of the eight
 * happened to have a failure recorded against it.
 *
 * Until now this was a paragraph in AGENTS.md saying "ask the reports before the tables", which is
 * a rule that holds exactly as long as everyone has read it. These are the ways a file is allowed
 * to name the table.
 */
const MAY_NAME_SOURCES = [
  // The registry itself, and the writers: the poller and the storage layer own the rows.
  /^src\/sources\//,
  /^src\/storage\//,
  /^src\/poller\.ts$/,
];

/**
 * Whether a statement reads `sources` as a list of sources, which is the only shape that can
 * silently include a retired one.
 *
 * A write is fine: the writer is what puts the row there. A lookup keyed on `sources.id` is fine
 * too, and is most of the uses -- `LEFT JOIN sources src ON src.id = e.source` asks which vendor
 * an event came from, and an event from a source retired last week still came from it. What is
 * left is a query that produces source rows nobody constrained, which is the one that counts eight
 * dead collectors as eight live ones.
 */
function readsSourcesAsAList(sql: string): boolean {
  if (!tablesNamed(sql).includes("sources")) return false;
  if (!/^\s*(?:select|with)\b/i.test(sql)) return false;
  if (/\bjoin\s+sources\s+(?:as\s+)?(\w+)\s+on\s+\1\.id\s*=/i.test(sql)) return false;
  if (/\bfrom\s+sources\b/i.test(sql) && /\bwhere\s+id\s*=\s*\?/i.test(sql)) return false;
  return true;
}

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

/** Which files build the registry, and so are already filtering by it. */
const filtersByRegistry = new Set(
  statements
    .map((statement) => statement.file)
    .filter((file) => readFileSync(join(root, file), "utf8").includes("buildSourceRegistry")),
);

const unfiltered = statements.filter(
  (statement) =>
    readsSourcesAsAList(statement.sql) &&
    !MAY_NAME_SOURCES.some((allowed) => allowed.test(statement.file)) &&
    !filtersByRegistry.has(statement.file),
);
for (const statement of unfiltered)
  findings.push(
    `${statement.file}:${statement.line}: reads \`sources\` without the registry, so a retired source counts -- ` +
      statement.sql.replace(/\s+/g, " ").trim(),
  );

if (findings.length) {
  console.error(`SQL the gate refuses:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `SQL check passed: ${statements.length} statements name only tables and columns the migrations create, ` +
    "and every read of `sources` goes through the registry" +
    `${unparsed ? ` (${unparsed} assembled at run time and not parsed)` : ""}.`,
);
