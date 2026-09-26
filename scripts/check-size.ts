/**
 * No declaration in `src/` may get longer than it already is, and a new one may not start long.
 *
 * `split-module` made file length cheap to fix, and the gate has said nothing about the thing
 * underneath it: `recapContext` is 342 lines of code in one function, `prepareDeliveries` 303,
 * `listActionableIssues` 267. A file that long is a filing problem. A function that long is where
 * the behaviour is, and it is the reason every change to recaps means reading four hundred lines
 * to find out whether the change is safe.
 *
 * A limit alone would fail on day one against forty declarations nobody is about to rewrite, so
 * this is a ratchet instead. Every declaration already over the line has a budget recorded below,
 * its own size rounded up to the next 25, and the budget can only be lowered -- by hand, in a diff
 * somebody reads. Anything not listed has to fit in LIMIT. A declaration that has shrunk below its
 * budget fails too, with the number to paste: a ratchet that is not tightened is a limit.
 *
 * Comment lines do not count. This repository is deliberately heavily commented and a rule that
 * charges for explaining yourself buys shorter functions with worse ones. Neither do the
 * continuation lines of a concatenated string, for the same reason and against the same mistake:
 * the operation registry documents itself in `summary` and `note` fields, which are string values
 * rather than comments, so a command explaining itself in six lines used to cost six. It cost this
 * repository one, measured: a `note` added to `silent_sources` put `sourcesOperations` over its
 * budget, and the way out was to fold four sentences onto one 400-character line.
 *
 * `--top <n>` prints the longest declarations with their budgets, which is the list of work this
 * file claims to be and could not be read as until it could be printed.
 *
 * BUDGET is closed. It is a record of what was already over the line on the day the ratchet was
 * built, not a list of exemptions to apply for, and the failure message used to offer adding to it
 * as one of two equal ways out. The cheaper way out of a rule is the one that gets taken, so the
 * message now offers one: split it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chunks, importBlock } from "./moduleParts.js";

const root = resolve(import.meta.dir, "..");

/** Code lines. A declaration that needs more than this is two declarations. */
const LIMIT = 80;

/**
 * What was already over the line when this check was written, rounded up to the next 25.
 *
 * Read it as a list of work, not as exceptions. The headroom is deliberate: a section of the
 * operation registry gaining one more command should not fail the gate, and gaining a hundred
 * lines should.
 */
const BUDGET: Readonly<Record<string, number>> = {
  "src/reports/issues.ts:listActionableIssues": 275,
  "src/operations/health.ts:healthOperations": 175,
  "src/delivery.ts:deliverPending": 100,
  "src/events/store.ts:persistCollection": 225,
  "src/operations/delivery.ts:deliveryOperations": 200,
  "src/reports/signalQuality.ts:signalQuality": 225,
  "src/events/render/facts.ts:eventFactParts": 200,
  "src/http.ts:createHttpApp": 200,
  "src/operations/sources.ts:sourcesOperations": 150,
  "src/sources/packs/catalogues.ts:cataloguesSources": 200,
  "src/sources/packs/community.ts:communitySources": 200,
  "src/events/render/discord.ts:eventEmbed": 175,
  "src/operations/evidence.ts:evidenceOperations": 175,
  "src/events/render/shape.ts:shape": 150,
  "src/operations/database.ts:databaseOperations": 125,
  "src/reports/sourceVerdicts.ts:sourceVerdicts": 150,
  "src/sources/catalogs.ts:PROVIDER_CATALOGUES": 150,
  "src/summary.ts:summarizeEvents": 150,
  "src/alerts.ts:publishAlerts": 125,
  "src/events/signals.ts:signalClass": 125,
  "src/poller.ts:collectDueSources": 125,
  "src/runtime/worker.ts:startIntervalWorker": 125,
  "src/sources/labels.ts:STATIC_LABELS": 125,
  "src/sources/packs/lifecycle.ts:lifecycleSources": 125,
  "src/sources/pages.ts:WATCHED_SITES": 125,
  "src/status.ts:sourceHealth": 125,
  "src/events/render/story.ts:storyEmbed": 100,
  "src/reports/flakySources.ts:flakySources": 100,
  "src/reports/news.ts:news": 100,
  "src/sources/deepseek.ts:parseDeepSeekPricing": 100,
  "src/sources/github.ts:collectGithubPulls": 100,
  "src/sources/http.ts:fetchText": 100,
  "src/sources/lifecycle.ts:parseTableRecords": 100,
  "src/sources/modelMentions.ts:collectModelMentions": 100,
  "src/status.ts:sendBoard": 100,
  "src/stories.ts:listStories": 100,
  "src/telegramReactions.ts:readTelegramReactions": 100,
};

/** The next budget a size would be recorded at: its own size, rounded up to the next 25. */
export function budgetFor(size: number): number {
  return Math.ceil(size / 25) * 25;
}

export type Measured = { name: string; size: number };

/** A line that is one string and a `+`: the second and later lines of a documented field's text. */
const CONTINUED_STRING = /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\+\s*$/;

/** Code lines in a declaration: no blanks, no comments, no continued text, from start to end. */
export function measure(text: string): number {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*(?:\/\/|\/\*|\*)/.test(line) && !CONTINUED_STRING.test(line)).length;
}

export function tooLong(measured: Measured[], budget: Readonly<Record<string, number>>, limit: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name, size } of measured) {
    seen.add(name);
    const allowed = budget[name];
    if (allowed === undefined) {
      if (size > limit)
        problems.push(
          `${name} is ${size} code lines, over the ${limit} a new declaration gets. Split it: \`bun run check-size --top 20\` shows what that looked like the last twenty times. BUDGET is closed -- it records what was already here when the ratchet was built, and a new line in it is the ratchet turning the wrong way.`,
        );
      continue;
    }
    if (size > allowed)
      problems.push(
        `${name} is ${size} code lines, over its recorded budget of ${allowed}. The ratchet only turns down.`,
      );
    if (budgetFor(size) < allowed)
      problems.push(
        `${name} is ${size} code lines and its budget is ${allowed}. Lower it to ${budgetFor(size)}: a ratchet nobody tightens is a limit.`,
      );
  }
  for (const name of Object.keys(budget))
    if (!seen.has(name)) problems.push(`BUDGET records ${name}, which no longer exists. Remove the line.`);
  return problems;
}

function every(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) every(path, found);
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

if (import.meta.main) {
  const measured: Measured[] = [];
  for (const path of every(join(root, "src"))) {
    const lines = readFileSync(path, "utf8").split("\n");
    const body = lines.slice(importBlock(lines).end);
    for (const chunk of chunks(body))
      measured.push({ name: `${relative(root, path)}:${chunk.name}`, size: measure(chunk.text) });
  }
  const top = Bun.argv.includes("--top") ? Number(Bun.argv[Bun.argv.indexOf("--top") + 1] ?? 20) : 0;
  if (top > 0) {
    const longest = [...measured].sort((left, right) => right.size - left.size).slice(0, top);
    const width = Math.max(...longest.map((entry) => entry.name.length));
    for (const { name, size } of longest)
      process.stdout.write(
        `${String(size).padStart(4)}  ${name.padEnd(width)}  ${BUDGET[name] ? `budget ${BUDGET[name]}` : `limit ${LIMIT}`}\n`,
      );
    process.exit(0);
  }
  const problems = tooLong(measured, BUDGET, LIMIT);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  const over = measured.filter((entry) => entry.size > LIMIT).length;
  process.stdout.write(
    `Declaration size passed: ${measured.length} declarations in src/, ${over} over ${LIMIT} code lines and all within budget.\n`,
  );
}
