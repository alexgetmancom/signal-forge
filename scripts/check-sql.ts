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
import { literals, readsEventBodies, readsEventsUnbounded, STARTS, tablesNamed } from "./sqlLiterals.js";

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
 *
 * Migration 071 gave the registry a second way in. A boot stamps `retired_at` on every row the
 * registry no longer names, and `live_sources` is the table without them, so a read of that view
 * cannot include a retired source and needs no registry in the file. It is the answer to give a
 * hand-written query, and it is not caught by this rule because `tablesNamed` sees a different
 * table. Reading `sources` itself as a list is still refused: a row is only stamped once a boot has
 * run, and a read of the table says nothing about which of its rows that was true of.
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

/**
 * The third rule: a read that takes event bodies is one of the reads that answer with them.
 *
 * `before_json` and `after_json` are where every byte this service has ever collected is kept, and
 * nothing deletes an event, so a read that selects them costs whatever the archive has grown to
 * rather than whatever it answers with. Twice in two days that was the whole cost of a report: the
 * story list read 27.6 MB of bodies to keep seven fields of each and took 170 MB of a floor that is
 * never given back, and `coverage_gaps` read fourteen days of them to keep a URL and a few words.
 * Both are one line of SQL away from being free -- ask for the keys, not the body -- and both looked
 * exactly like a read that is supposed to carry a record.
 *
 * `read-cost` finds this by measuring and cannot run in the gate, because it needs production. This
 * is the half that can: every read below carries a body on purpose, and a new one has to say so
 * here, in a diff somebody reads. Selecting a whole event by its id is not listed and not refused --
 * one body is not a floor -- and neither is a body a `json_extract` reaches into, which is the
 * cheap shape this exists to push a read towards.
 *
 * An entry that no longer matches anything fails too, the way `check-size`'s budgets do: a list of
 * reads that carry bodies is only worth having if it is the list of reads that carry bodies.
 */
const MAY_READ_BODIES: Readonly<Record<string, string>> = {
  "src/recap/reading.ts": "the weekly recap renders every event of the week it summarises",
  "src/summary.ts": "a summary uses the full observation, not the shortened card",
  "src/insights.ts": "insights are derived from what the records say, commit messages and headlines",
  "src/lifecycle.ts": "a deadline is read off the record that announced it",
  "src/modelFacts.ts": "Model Facts is a projection of the records themselves",
  "src/hypotheses.ts": "a hypothesis is made of the record fields it is about",
  "src/amendments.ts": "an amendment is the difference between two bodies of the same incident",
  "src/events/oscillation.ts": "a flapping value is only visible in the values",
  "src/events/corroboration.ts": "two sources agree or disagree about the contents of a record",
  "src/events/breakouts.ts": "a breakout is a price or a context length inside the record",
  "src/events/cooldown.ts": "what was told before is compared with what the record now says",
  "src/events/rename.ts": "a rename is the same record under a different name",
  "src/events/batchPolicy.ts": "a card is rendered from the event it is about",
  "src/events/toldBefore.ts": "a repeat is found by comparing what the records said",
  "src/jev.ts": "the judge is shown the record, which is the evidence it judges",
  "src/reports/channelMix.ts": "it renders the cards it reports on",
  "src/reports/news.ts": "the story cards are rendered from their events",
  "src/reports/releaseAudit.ts": "it renders every card of the window to audit them",
  "src/storage/webEvidence.ts":
    "it rewrites the bodies, chunked and largest first, and cannot narrow what it has not read",
  "src/reports/storage.ts": "it sums the length of every body in SQLite and one number leaves, never a body",
  "src/reports/releaseRender.ts": "the fingerprint is the rendered cards, in a child that ends",
};

/**
 * The fourth rule: a read of `events` is bounded by something, or it is one of the reads that cannot
 * be.
 *
 * Nothing deletes an event. A read of this table with no window, no key, no aggregate and no limit
 * therefore costs whatever the archive has grown to, and it grows on its own: the read is cheap the
 * day it is written, it is never edited again, and no report says which read the rising floor belongs
 * to. `announcementsBySubject` was exactly that -- every newsroom `new` event ever recorded, to
 * answer whether one model had been announced -- and it was found by reading the code, not by any
 * check.
 *
 * `readsEventsUnbounded` says what counts as bounded, and the four ways are generous on purpose: the
 * point is to make the cheap shape the easy one, not to collect exceptions. The six below are the
 * reads that genuinely cannot be bounded, and they divide into two kinds. A projection is over all of
 * history by definition -- it is rebuilt from every event there has ever been, which is why the three
 * of them are rebuilt in pages or streamed row by row rather than materialised. The others are bounded
 * by a small table they are driven from, or aggregated by SQLite into a row per subject.
 *
 * As with `MAY_READ_BODIES`, an entry that no longer matches anything fails: a list of the reads that
 * cannot be bounded is only worth having if it is the list of reads that cannot be bounded.
 */
const MAY_READ_EVERY_EVENT: Readonly<Record<string, string>> = {
  "src/stories.ts": "the story projection is every event in `detected_at` order, read a page at a time",
  "src/modelFacts.ts": "Model Facts is a projection of every event of every story, streamed one story at a time",
  "src/hypotheses.ts": "a hypothesis is derived from a story's whole evidence, and a rebuild is over every story",
  "src/lifecycle.ts": "every deadline this service has ever been told about is re-read on a boot",
  "src/events/cooldown.ts": "driven from the suppressions still holding a move, which is a handful of rows",
  "src/events/witness.ts": "the witness index is one row per subject, grouped by SQLite rather than here",
};

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
      "read `live_sources` instead, or build the registry: " +
      statement.sql.replace(/\s+/g, " ").trim(),
  );

const bodyReaders = new Set(
  statements
    .filter((statement) => statement.file.startsWith("src/") && readsEventBodies(statement.sql))
    .map((s) => s.file),
);
for (const file of [...bodyReaders].sort())
  if (!(file in MAY_READ_BODIES))
    findings.push(
      `${file}: reads event bodies, which cost what the archive has grown to rather than what the answer keeps. ` +
        "Select the keys the answer uses -- `json_extract` of a body is not a body -- or, if the read really does " +
        "carry a record, add the file to MAY_READ_BODIES in this script with the reason.",
    );
for (const file of Object.keys(MAY_READ_BODIES).sort())
  if (!bodyReaders.has(file))
    findings.push(`${file}: listed in MAY_READ_BODIES and no longer reads an event body -- delete the line.`);

const wholeArchiveReaders = new Set(
  statements
    .filter((statement) => statement.file.startsWith("src/") && readsEventsUnbounded(statement.sql))
    .map((statement) => statement.file),
);
for (const file of [...wholeArchiveReaders].sort())
  if (!(file in MAY_READ_EVERY_EVENT))
    findings.push(
      `${file}: reads \`events\` with no window, no key, no aggregate and no limit, so what it costs is ` +
        "whatever the archive has grown to and it grows on its own. Bound it by a window over a timestamp or by " +
        "the key the caller already has -- or, if the read really is over all of history, add the file to " +
        "MAY_READ_EVERY_EVENT in this script with the reason.",
    );
for (const file of Object.keys(MAY_READ_EVERY_EVENT).sort())
  if (!wholeArchiveReaders.has(file))
    findings.push(`${file}: listed in MAY_READ_EVERY_EVENT and no longer reads every event -- delete the line.`);

/**
 * The sixth rule: a table SQL names is one the migrations create, or one of SQLite's own that the
 * production build is known to have.
 *
 * `db.prepare` above is the parser that will run the statement -- on *this* machine. SQLite's
 * eponymous virtual tables are compile-time options, and the two builds are not the same: Bun on
 * macOS links a SQLite with `dbstat`, Bun on Debian and Alpine does not. So `src/reports/storage.ts`
 * reading `dbstat` to weigh each table prepared cleanly here, passed all thirteen checks here, and
 * was `no such table: dbstat` the moment it ran anywhere else. The whole report threw on production.
 *
 * CI caught it on Linux, an hour and a deploy later. This catches it on the machine that wrote it,
 * because the schema the migrations build is the oracle and anything else has to be named here.
 *
 * Every entry below was verified inside the running container on 2026-10-03, which is the only
 * thing that makes this list worth anything: `sqlite_master`, `sqlite_stat1`, `pragma_table_info`,
 * `pragma_index_info` and `json_each` all answer there; `dbstat` is the one that does not. Adding a name means checking it there too --
 * `ssh vm106`, `docker exec signal-forge-app-1 bun -e '...'` -- and not on this machine, where the
 * answer is yes to things production has never had.
 */
const SQLITE_OWN_TABLES: Readonly<Record<string, string>> = {
  sqlite_master: "the schema itself, which every build has",
  pragma_table_info: "the columns of a table, which is how the storage report weighs one portably",
  pragma_index_info: "the columns of an index, including the ones SQLite declared itself",
  json_each: "JSON1, compiled into every Bun",
};

/**
 * The names that are allowed to be missing from production, because the file naming them never runs
 * there.
 *
 * `dbstat` is the whole reason: it is the only way to learn what one index costs, production's build
 * does not have it, and the question is still worth asking -- of a copy, on this machine, which is
 * where `probe`, `index-cost` and the rehearsals already do their work. The rule above is about a
 * name reaching production; a script that cannot reach production is not it.
 *
 * `src/` is not eligible and the check says so: everything there is shipped, including the half of
 * it that only an operator calls.
 */
const MAY_NAME_WHAT_PRODUCTION_LACKS: Readonly<Record<string, string>> = {
  "scripts/index-cost.ts": "dbstat is the only per-index size there is, and this runs against a copy here",
};

/** The names a statement introduces itself, which are not tables and cannot be checked against one. */
function commonTableExpressions(sql: string): string[] {
  return [...sql.matchAll(/\b(?:with(?:\s+recursive)?|,)\s+([a-z_]\w*)\s+as\s*\(/gi)].map((match) =>
    (match[1] as string).toLowerCase(),
  );
}

const schemaTables = new Set(
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master")
    .all()
    .map((row) => row.name.toLowerCase()),
);
const namedOwnTables = new Set<string>();
const namedLocalOnly = new Set<string>();
for (const statement of statements) {
  const introduced = commonTableExpressions(statement.sql);
  for (const table of tablesNamed(statement.sql)) {
    if (schemaTables.has(table) || introduced.includes(table) || table === "?") continue;
    if (table in SQLITE_OWN_TABLES) {
      namedOwnTables.add(table);
      continue;
    }
    if (statement.file in MAY_NAME_WHAT_PRODUCTION_LACKS) {
      namedLocalOnly.add(statement.file);
      continue;
    }
    findings.push(
      `${statement.file}:${statement.line}: names \`${table}\`, which the migrations do not create. If it is ` +
        "SQLite's own, it is a compile-time option this machine may have and production may not -- `dbstat` is " +
        "exactly that, and shipped a report that threw. Check it inside the container, then add it to " +
        `SQLITE_OWN_TABLES in this script: ${statement.sql.replace(/\s+/g, " ").trim()}`,
    );
  }
}
for (const [table, why] of Object.entries(SQLITE_OWN_TABLES))
  if (!namedOwnTables.has(table))
    findings.push(`${table}: listed in SQLITE_OWN_TABLES (${why}) and no longer named by any SQL -- delete the line.`);
for (const [file, why] of Object.entries(MAY_NAME_WHAT_PRODUCTION_LACKS)) {
  if (file.startsWith("src/"))
    findings.push(`${file}: listed in MAY_NAME_WHAT_PRODUCTION_LACKS, but everything in src/ is shipped.`);
  else if (!namedLocalOnly.has(file))
    findings.push(
      `${file}: listed in MAY_NAME_WHAT_PRODUCTION_LACKS (${why}) and names nothing production lacks -- delete the line.`,
    );
}

/**
 * The fifth rule: a transaction in `src/` starts as a writer.
 *
 * A deferred `BEGIN` that reads before it writes is refused the moment another connection holds the
 * lock or commits first, without waiting for the `busy_timeout` that was set so that it would. On
 * production that was twenty-seven collections a week recorded as failed -- `SQLITE_BUSY` sixteen
 * times and `SQLITE_BUSY_SNAPSHOT` eleven -- each one a red source for the cycle it took to try again.
 * `writeTransaction` in `src/storage/transaction.ts` is `BEGIN IMMEDIATE`, and a bare
 * `db.transaction(...)` is how the fault comes back: it compiles, passes every test that has only one
 * connection, and fails on the one machine that has two.
 */
const TRANSACTION_HELPER = "src/storage/transaction.ts";
for (const file of walk(join(root, "src"))) {
  const name = relative(root, file);
  if (name === TRANSACTION_HELPER) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (!/\.(?:transaction|deferred|exclusive)\(/.test(line)) return;
      findings.push(
        `${name}:${index + 1}: a bare transaction is deferred, and one that reads first is refused instead of ` +
          `waiting for the lock -- use writeTransaction(db, work) from ${TRANSACTION_HELPER}: ${line.trim().slice(0, 100)}`,
      );
    });
}

if (findings.length) {
  console.error(`SQL the gate refuses:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `SQL check passed: ${statements.length} statements name only tables and columns the migrations create, ` +
    "every read of `sources` goes through the registry, and every read of an event body is one of the " +
    `${Object.keys(MAY_READ_BODIES).length} that answer with one, and every read of \`events\` is bounded by a ` +
    `window, a key, an aggregate or a limit apart from the ${Object.keys(MAY_READ_EVERY_EVENT).length} that are ` +
    "projections of all of it, and every transaction in src/ starts as a writer, and every table named is one " +
    `the migrations create or one of the ${Object.keys(SQLITE_OWN_TABLES).length} of SQLite's own that production's ` +
    "build was checked to have" +
    `${unparsed ? ` (${unparsed} assembled at run time and not parsed)` : ""}.`,
);
