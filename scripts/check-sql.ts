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
import { literals, readsEventBodies, STARTS, tablesNamed } from "./sqlLiterals.js";

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
  "src/recap.ts": "the weekly recap renders every event of the week it summarises",
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
  "src/events/batching.ts": "a card is rendered from the event it is about",
  "src/events/toldBefore.ts": "a repeat is found by comparing what the records said",
  "src/jev.ts": "the judge is shown the record, which is the evidence it judges",
  "src/reports/channelMix.ts": "it renders the cards it reports on",
  "src/reports/news.ts": "the story cards are rendered from their events",
  "src/reports/releaseAudit.ts": "it renders every card of the window to audit them",
  "src/reports/releaseRender.ts": "the fingerprint is the rendered cards, in a child that ends",
  // This one is work, not an answer: 36 MB to answer with 110 KB, because `hasNotificationContent`
  // and the independence family each need a record. Measured 2026-09-27; the reads above it on that
  // list have been rewritten and this is the last of the four.
  "src/reports/signalQuality.ts": "not yet rewritten: it needs a record per event to decide two flags",
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

if (findings.length) {
  console.error(`SQL the gate refuses:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `SQL check passed: ${statements.length} statements name only tables and columns the migrations create, ` +
    "every read of `sources` goes through the registry, and every read of an event body is one of the " +
    `${Object.keys(MAY_READ_BODIES).length} that answer with one` +
    `${unparsed ? ` (${unparsed} assembled at run time and not parsed)` : ""}.`,
);
