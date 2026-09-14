/**
 * The documentation set is closed.
 *
 * Prose multiplies on its own: every session that learns something wants a file to put it in, and
 * a year of that is eight documents, three of which describe a system that has since changed and
 * none of which anybody reads before writing the ninth. This repository had exactly that -- 2203
 * lines across eight files, of which a 1022-line competitor audit and a sixty-bullet list of
 * completed work were describing the past.
 *
 * So the set is fixed here, in the gate, rather than in an instruction somebody has to remember.
 * Each file has one job and a budget; a new one fails the check with the question of which existing
 * file the content belongs in. Adding a file is a deliberate edit to this list, which is the point:
 * it is a decision, not a side effect of writing something down.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Path, what it is for, and the line budget past which it is being written instead of the code. */
const DOCUMENTS: Record<string, { purpose: string; lines: number }> = {
  "README.md": { purpose: "what this service is, for somebody who has never seen it", lines: 420 },
  "AGENTS.md": { purpose: "how work is done here", lines: 120 },
  "docs/roadmap.md": { purpose: "the plan, and the decisions measurement already settled", lines: 200 },
  "docs/runbook.md": { purpose: "which script to run when, and what a script cannot know", lines: 140 },
  "docs/discord.md": { purpose: "the delivery contract: classes, routing, what never becomes a card", lines: 260 },
};

const SKIP = new Set(["node_modules", ".git", "dist", "data", "backups", "coverage"]);

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    // CLAUDE.md is a symlink to AGENTS.md: one file, two names an agent might look for.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, found);
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(relative(root, path));
  }
  return found;
}

const failures: string[] = [];
const present = walk(root);

for (const path of present) {
  if (DOCUMENTS[path]) continue;
  failures.push(
    `${path} is a new document. The set is closed; put it in the file whose job it is:\n` +
      Object.entries(DOCUMENTS)
        .map(([name, { purpose }]) => `    ${name} — ${purpose}`)
        .join("\n") +
      "\n    a comment next to the code — why that code is the way it is\n" +
      "  If none of them fits, add the file to scripts/check-docs.ts in the same commit and say why.",
  );
}

for (const [path, { lines }] of Object.entries(DOCUMENTS)) {
  if (!statSync(join(root, path), { throwIfNoEntry: false })?.isFile()) {
    failures.push(`${path} is missing: it is in the documented set and something deleted it.`);
    continue;
  }
  const actual = readFileSync(join(root, path), "utf8").split("\n").length;
  if (actual > lines)
    failures.push(
      `${path} is ${actual} lines, past its ${lines}-line budget. Either it is repeating the code, ` +
        "or it has grown a section that belongs in another file. Raise the budget here only when the " +
        "longer version is the one worth keeping.",
    );
}

if (failures.length) {
  console.error(`Documentation set violated:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log(`Documentation set intact: ${present.length} files, each inside its budget.`);
