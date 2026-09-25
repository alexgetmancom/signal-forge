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
 * charges for explaining yourself buys shorter functions with worse ones.
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
  "src/recap.ts:recapContext": 350,
  "src/events/batching.ts:prepareDeliveries": 325,
  "src/sources/packs/news.ts:newsSources": 325,
  "src/reports/issues.ts:listActionableIssues": 275,
  "src/operations/health.ts:healthOperations": 200,
  "src/delivery.ts:deliverPending": 225,
  "src/events/store.ts:persistCollection": 225,
  "src/operations/delivery.ts:deliveryOperations": 225,
  "src/reports/signalQuality.ts:signalQuality": 225,
  "src/events/render/facts.ts:eventFactParts": 200,
  "src/http.ts:createHttpApp": 200,
  "src/operations/sources.ts:sourcesOperations": 200,
  "src/sources/packs/catalogues.ts:cataloguesSources": 200,
  "src/sources/packs/community.ts:communitySources": 200,
  "src/events/render/discord.ts:eventEmbed": 175,
  "src/operations/evidence.ts:evidenceOperations": 175,
  "src/events/render/shape.ts:shape": 150,
  "src/operations/database.ts:databaseOperations": 150,
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

/** Code lines in a declaration: no blanks, no comments, from the declaration to the end of it. */
export function measure(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "" && !/^\s*(?:\/\/|\/\*|\*)/.test(line)).length;
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
          `${name} is ${size} code lines, over the ${limit} a new declaration gets. Split it, or record it in BUDGET as ${budgetFor(size)} and say why in the commit.`,
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
