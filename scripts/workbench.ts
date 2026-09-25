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
    group: "change",
    command: "split-module",
    when: "A module is too long and the parts of it are obvious. Choosing what belongs together is the work; this does the rest, and refuses rather than guesses when it cannot reassemble the file it read.",
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
    when: "Before changing anything a reader sees. It replays real production history twice, at a base ref and in this working tree, in two phases: which cards are sent, and what those cards say. `--all` adds the projection and migration rehearsals; `--list` says what they are. Measure here, not in the channel.",
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
    when: "Part of the gate, and the thing that makes a column name in a SQL string a compile error rather than an empty report. It builds the schema from the migrations in memory and asks SQLite to prepare every statement in src/ and scripts/. tests/ is deliberately out: a wrong name there fails the second the test runs.",
  },
  {
    group: "prove",
    command: "check-size",
    when: "Part of the gate. No declaration in src/ may get longer than it already is, and a new one may not exceed 80 code lines. The forty already over that have a recorded budget in the script, which can only be lowered -- read it as a list of work rather than a list of exceptions.",
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
