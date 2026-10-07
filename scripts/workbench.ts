/**
 * What this repository's own commands are, and when to reach for each one.
 *
 * The service has a guide that is generated from the operation registry, so a command that exists
 * is a command that is described and nothing can drift. The development commands had the opposite
 * arrangement: a paragraph each in AGENTS.md, hand-written, hand-maintained, and half of it
 * describing things `prod guide` already described better. Fourteen of the twenty-two bullets in
 * that file were about one command.
 *
 * So this is the same arrangement for the other half. Every `bun run` script has an entry here
 * saying when it is the right thing to run, `check-scripts` fails the gate when one does not, and
 * AGENTS.md says what is left: the things that are not a command.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Bench = { group: string; command: string; when: string };

/** Ordered the way a session goes: ask, change, prove, ship. */
export const BENCH: Bench[] = [
  {
    group: "ask",
    command: "guide",
    when: "This list: every command this repository has and when to reach for it. AGENTS.md carries only what is not a command.",
  },
  {
    group: "ask",
    command: "prod guide",
    when: "Every question about the running service starts here. It lists every command, a symptom index that maps a question to one, and `guide <command>` for how to read what one answers. Nothing about the service is written down anywhere else.",
  },
  {
    group: "ask",
    command: "prod traffic",
    when: "Which collector downloads the most for the least. Ranked by bytes per event, so the top row is the next one to narrow -- then `bun run probe` against that endpoint to compare what it asks for with the fields the collector reads.",
  },
  {
    group: "ask",
    command: "prod broken",
    when: "Open a session with it. It asks all four readings of 'broken' at once and says which sources more than one of them agrees on.",
  },
  {
    group: "ask",
    command: "prod sql",
    when: "A question no command answers. Every call is journalled, and `prod usage` says which of these has been asked by hand often enough to deserve a command of its own -- which is one entry in src/operations/, never a script on the host.",
  },
  {
    group: "ask",
    command: "probe",
    when: "A question that is not worth a command, against a copy of production with `db` and `config` already in scope: `bun run probe -e '<expression>'` or `bun run probe <file.ts>`. Read-only.",
  },
  {
    group: "ask",
    command: "source-cost",
    when: "Which sources set the floor this service stands on. RSS is a high-water mark that is never given back, so a source's cost is what it permanently adds the first time it runs, not what it holds while running; this runs each light source alone against a copy of production and names the ones that should be collected in a child process instead. Reach for it after adding a source that reads a whole page, a sitemap or a feed.",
  },
  {
    group: "ask",
    command: "read-cost",
    when: "Which reads set the floor this service stands on, the other half of `source-cost`. A read answered by `prod <command>` costs nothing lasting, but the same read over HTTP or MCP is answered inside the long-lived service and raises its floor for as long as it lives; this asks every read that needs no argument, twice, against a copy of production, and names the ones that claim more than a heavy collector does. Reach for it after adding a report or widening what one reads.",
  },
  {
    group: "ask",
    command: "index-cost",
    when: "What each index costs and which hot read it exists for -- the inside of the one number `prod storage` calls `unaccountedBytes`. Per-index bytes come from `dbstat`, production's SQLite is built without it, and this machine's is not, so the question is asked of a copy here rather than of the service. It also weighs the indexes whose use the schema cannot derive, which is the price of the list `check-indexes` keeps: the gate refuses a new index nothing explains and runs everywhere, this says what the explained-by-hand ones cost and needs a copy. Each run appends the index set, its reasons and its total to `.rehearsal/ledger.json`, fingerprinted over the schema rather than the bytes, so a later run can say the set is the one from four commits ago -- which is what \"how many indexes do we have\" means when it is asked across a week.",
  },
  {
    group: "change",
    command: "backfill-judgements",
    when: "The second half of raising `PROMPT_VERSION`. A bump reaches only the forty events the next cycle judges, so the stored history keeps its answers from the version before and the two scales cannot be compared -- which is the entire reason the version column exists. This asks the current questions of as many days back as `--days` gives it, a window at a time, and only of what the current version has not answered, so an interrupted run resumes and a run with the prompt unchanged asks nothing. `--dry-run` is the count on its own: judgeable events, answered, pending. Run against production with `--db /app/data/app.db` inside the container, where the script lives as `/app/dist/scripts/backfill-judgements.js`.",
  },
  {
    group: "check",
    command: "check-indexes",
    when: "Part of `check`, and listed here because it is the enforcement of a rule AGENTS.md states: a new index ships with the statement it was for. It derives four kinds of use from the schema alone -- a hot read's plan, a hot write's plan, a UNIQUE constraint, a foreign key's referential action -- and fails on anything left over, and separately refuses a pair of indexes on one table where one's columns lead the other's. Reach for it directly when a migration adds an index and you want to know what the gate will say before the gate says it; `index-cost` is the same question with bytes attached and a copy of production required.",
  },
  {
    group: "change",
    command: "split-module",
    when: "A module is too long and the parts of it are obvious. Choosing what belongs together is the work; this does the rest, and refuses rather than guesses when it cannot reassemble the file it read.",
  },
  {
    group: "change",
    command: "squash-migrations",
    when: "The migrations directory has grown past its baseline and production has run them: every new database and every test replays each file for nothing. This folds everything up to the version on origin/main into one baseline file, keeps what is above it, and writes nothing unless a replay of the old journal and of the new one produce the same schema. `--dry-run` says what it would do. Run it after a deploy, never before: a version production does not hold yet must stay a migration.",
  },
  {
    group: "change",
    command: "format",
    when: "After any generated or mechanical edit, before the gate.",
  },
  {
    group: "prove",
    command: "check",
    when: "The whole gate, and the same one the pre-push hook and CI run. scripts/check-steps.ts is the list, and adding a rule means adding a step there.",
  },
  {
    group: "prove",
    command: "check-fast",
    when: "`bun run check-fast <word>` is the inner loop: everything except the dependency audit, the build and the dead-code pass, with the test run narrowed to files matching the word. One second against the gate's fifty.",
  },
  {
    group: "prove",
    command: "rehearse",
    when: "Before changing anything a reader sees. It replays real production history twice, at a base ref and in this working tree, in two phases by default: which cards are sent, and what those cards say. Five more run on request: `stories` answers which events share a story, which no card replay can see because it renders each event alone, and `evidence` is the one to reach for when the change is to the form of a stored body rather than to a reader of one -- it derives every view of every event ever stored, both ways, which is how a representation that saves 31 MB is shown to have moved nothing. `--needed` works out which phases the diff owes from the import graph rather than from a list of file names -- a replayed entry point reaching a file is what makes that file owe the phase; `--all` runs every one; `--list` says what they are; `--prune` throws the copy away. Measure here, not in the channel.",
  },
  {
    group: "prove",
    command: "rehearse-projections",
    when: "Before changing Model Facts, hypotheses or stories. It rebuilds in full on a copy of production and checks two things the tests cannot: that an incremental update of every source and every story changes nothing, and that revealing the newest events one at a time lands on the same bytes as a full rebuild. Three real bugs so far that 793 tests passed straight through.",
  },
  {
    group: "prove",
    command: "rehearse-migration",
    when: "Before shipping a migration. It runs on a copy of production, reports what the migration did to stored record bodies -- reword one and the next collection emits a 'changed' event for every record carrying it -- and runs EXPLAIN QUERY PLAN over src/storage/hotQueries.ts before and after, failing on a read that was a SEARCH and came back a SCAN. Ship `ANALYZE;` in the same migration: until sqlite_stat1 is populated the planner ignores a new index, and from outside that is indistinguishable from not having created it.",
  },
  {
    group: "prove",
    command: "check-sql",
    when: "Part of the gate, and the thing that makes a column name in a SQL string a compile error rather than an empty report. It builds the schema from the migrations in memory and asks SQLite to prepare every statement in src/ and scripts/. tests/ is deliberately out: a wrong name there fails the second the test runs. It carries three rules the parser cannot see as well: a read of `sources` goes through the registry; a read that takes `before_json` or `after_json` for more than one event is one of the reads listed in the script as answering with a record; and a read of `events` is bounded by a window, a key, an aggregate or a limit unless it is one of the projections listed as being over all of history. Those last two are the half of `read-cost` that needs no production -- one would have caught the story list reading 27.6 MB of bodies to keep seven fields, the other the announcement read that grew with every newsroom post this service will ever record.",
  },
  {
    group: "prove",
    command: "check-size",
    when: "Part of the gate. No declaration in src/ may get longer than it already is, and a new one may not exceed 80 code lines. The forty already over that have a recorded budget in the script, which can only be lowered -- read it as a list of work rather than a list of exceptions.",
  },
  {
    group: "prove",
    command: "check-failures",
    when: 'Part of the gate. Nothing a collection passes through throws a bare Error, because the poller files that as unknown and prints it as "unexpected error (Error)": a collector throws SourceError(kind, message) or httpFailure(message, status), and the write path throws storageFailure(what) when a write did not take effect. Scope is src/sources plus everything imported from src/events/pipeline.ts; the throws no collection can reach are listed in the script with why. It also checks that a collector reaches the network only through src/sources/http.ts.',
  },
  {
    group: "prove",
    command: "check-vendors",
    when: "Part of the gate. Every laboratory this repository reads for by name -- a Model Garden publisher, a source's `vendor` -- can be placed by vendorOfName, or has a line in the script saying why it cannot. Unknown is not cosmetic: the model carries no maker on its card and OpenCode's reader now drops it outright. `unknown-makers` is the other half, and needs the service and a month of events.",
  },
  {
    group: "prove",
    command: "test",
    when: "`bun test <word>` narrows to matching files. Reach for tests/fixtures/build.ts before writing an INSERT: anEvent, aSnapshot, anAttempt and aCall produce rows that satisfy the CHECK constraints.",
  },
  {
    group: "ship",
    command: "ship",
    when: "Deploy is a push. `git push`, find the run by head SHA, `gh run watch --exit-status`, then `prod verify <symbol>` -- the symbol in /app/dist is the only check of the four that can tell a new image from an old one still running.",
  },
  {
    group: "ship",
    command: "prod",
    when: "Every operator command, run against production over ssh. Read-only unless the command is one of the two that are not.",
  },
  {
    group: "ship",
    command: "prod:mcp",
    when: "The same registry as an MCP server, for a tool-using client.",
  },
];

/** The scripts that exist to be run by something other than a person, and need no entry. */
export const MACHINERY = new Set([
  "dev",
  "start",
  "build",
  "typecheck",
  "lint",
  "check-architecture",
  "check-language",
  "check-audit",
  "check-dead-code",
  "check-migrations",
  "check-scripts",
  "install-hooks",
  "poll",
  "status",
  "events",
  "suppressions",
]);

export function scriptNames(root: string): string[] {
  const parsed = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  return Object.keys(parsed.scripts);
}

/** Which entries name nothing, and which scripts nothing names. Both are the same kind of drift. */
export function benchGaps(names: string[]): { undescribed: string[]; stale: string[] } {
  const described = new Set(BENCH.map((entry) => entry.command.split(" ")[0] as string));
  return {
    undescribed: names.filter((name) => !described.has(name) && !MACHINERY.has(name)),
    stale: [...described].filter((name) => !names.includes(name)),
  };
}

if (import.meta.main) {
  const width = Math.max(...BENCH.map((entry) => entry.command.length));
  let group = "";
  for (const entry of BENCH) {
    if (entry.group !== group) {
      process.stdout.write(`\n${entry.group}\n`);
      group = entry.group;
    }
    const wrapped = entry.when.match(/.{1,92}(\s|$)/g) ?? [entry.when];
    process.stdout.write(`  bun run ${entry.command.padEnd(width)}  ${wrapped[0]?.trim()}\n`);
    for (const line of wrapped.slice(1)) process.stdout.write(`${" ".repeat(width + 12)}${line.trim()}\n`);
  }
  process.stdout.write("\nEverything about the running service is in `bun run prod guide`, never here.\n");
}
