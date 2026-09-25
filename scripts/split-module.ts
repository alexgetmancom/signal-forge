/**
 * Moves top-level declarations out of one module into siblings, mechanically.
 *
 * This was done by hand twice -- `batching.ts` and then `discord.ts`, 1201 lines into seven files
 * -- and both times the work was not deciding what belonged together. That part takes a minute and
 * a human. The rest is bookkeeping: carry each declaration with the comment written above it,
 * give the new file exactly the imports its own text uses, leave behind an import for whatever the
 * original still calls, and repoint every other file in the tree that named a moved symbol. Done
 * by hand that is where the mistakes were -- an import of a symbol only a local variable shadowed,
 * an import left behind that nothing used any more.
 *
 * It refuses rather than guesses. The chunks it cut are reassembled and compared to the file it
 * read, byte for byte, before anything is written; a file it cannot take apart and put back
 * together exactly is a file it does not understand, and it says so instead of writing.
 *
 *   bun run split-module src/recap.ts periods.ts=PERIODS,RecapPeriod,lastRecapPeriod
 *
 * prints the plan. `--write` performs it. The result is a pure move, so the thing to run next is
 * whatever proves that: the tests, and for anything a reader sees, `bun run rehearse`.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type Chunk,
  chunks,
  DECLARATION,
  declaredWithin,
  importBlock,
  importedNames,
  importLines,
  mentions,
  type Origin,
  respecify,
} from "./moduleParts.js";

const root = resolve(import.meta.dir, "..");

function every(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) every(path, found);
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

const [target, ...assignments] = Bun.argv.slice(2).filter((value) => !value.startsWith("--"));
const write = Bun.argv.includes("--write");
if (!target || assignments.length === 0) {
  process.stderr.write("usage: bun run split-module <file.ts> <sibling.ts>=<Name,Name> [...] [--write]\n");
  process.exit(2);
}

const stem = target.split("/").pop() as string;
const path = resolve(root, target);
const source = readFileSync(path, "utf8");
const lines = source.split("\n");
const block = importBlock(lines);
const body = lines.slice(block.end);
const cut = chunks(body);
const header = body.slice(0, cut.length > 0 ? (cut[0] as Chunk).from : body.length);

const reassembled = [...block.preamble, ...block.statements, "", ...header, ...cut.map((chunk) => chunk.text)].join(
  "\n",
);
const normalise = (text: string) => text.replace(/\n+/g, "\n").trim();
if (normalise(reassembled) !== normalise(source)) {
  process.stderr.write(
    `${target}: cut into ${cut.length} declarations that do not reassemble into the file they came from. ` +
      "Nothing written: this module has a shape split-module does not understand.\n",
  );
  process.exit(1);
}

const plan = new Map<string, string[]>();
for (const assignment of assignments) {
  const [file, names] = assignment.split("=");
  if (!file || !names) {
    process.stderr.write(`not an assignment: ${assignment}\n`);
    process.exit(2);
  }
  plan.set(
    file,
    names.split(",").map((name) => name.trim()),
  );
}

const byName = new Map(cut.map((chunk) => [chunk.name, chunk]));
const destination = new Map<string, string>();
for (const [file, names] of plan)
  for (const name of names) {
    if (!byName.has(name)) {
      process.stderr.write(`${target} declares no top-level ${name}. It declares: ${[...byName.keys()].join(", ")}\n`);
      process.exit(2);
    }
    destination.set(name, file);
  }

const directory = dirname(path);
const imported = importedNames(block.statements);
const staying = cut.filter((chunk) => !destination.has(chunk.name));
const moduleName = (file: string) => `./${file.replace(/\.ts$/, ".js")}`;

/** What one set of chunks needs imported, given where every other name in the file now lives. */
function needs(taken: Chunk[], intoDirectory: string, self: string | null): Map<string, Origin> {
  const here = new Set(taken.map((chunk) => chunk.name));
  const needed = new Map<string, Origin>();
  for (const chunk of taken) {
    const shadowed = declaredWithin(chunk.text);
    for (const name of mentions(chunk.text)) {
      if (here.has(name) || shadowed.has(name)) continue;
      const outside = imported.get(name);
      if (outside) {
        needed.set(name, { module: respecify(outside.module, directory, intoDirectory), clause: outside.clause });
        continue;
      }
      const moved = destination.get(name);
      if (moved && moved !== self) needed.set(name, { module: moduleName(moved), clause: name });
      else if (!moved && byName.has(name) && self !== null)
        needed.set(name, {
          module: respecify(`./${stem.replace(/\.ts$/, ".js")}`, directory, intoDirectory),
          clause: name,
        });
    }
  }
  return needed;
}

/** A declaration that was private to its old file has to be exported out of its new one. */
function exported(chunk: Chunk): string {
  if (chunk.exported) return chunk.text;
  const lines = chunk.text.split("\n");
  const at = lines.findIndex((line) => DECLARATION.test(line));
  lines[at] = `export ${lines[at]}`;
  return lines.join("\n");
}

const written = new Map<string, string>();
for (const [file, names] of plan) {
  const taken = names.map((name) => byName.get(name) as Chunk);
  const into = join(directory, file);
  if (existsSync(into)) {
    process.stderr.write(`${relative(root, into)} already exists.\n`);
    process.exit(2);
  }
  const needed = needs(taken, dirname(into), file);
  written.set(
    into,
    [
      "/**",
      ` * ${taken.length} declaration${taken.length === 1 ? "" : "s"} moved out of ${stem} unchanged.`,
      " *",
      " * Say here what they have in common, because that is the only reason this file exists.",
      " */",
      ...importLines(needed),
      "",
      ...taken.map((chunk) => exported(chunk)),
      "",
    ].join("\n"),
  );
}

const remaining = needs(staying, directory, null);
for (const [name, origin] of imported) if (!remaining.has(name) && mentionsAnywhere(name)) remaining.set(name, origin);
function mentionsAnywhere(name: string): boolean {
  return staying.some((chunk) => mentions(chunk.text).has(name)) || mentions(header.join("\n")).has(name);
}
written.set(
  path,
  [...block.preamble, ...importLines(remaining), "", ...header, ...staying.map((chunk) => chunk.text), ""].join("\n"),
);

/** Every other file that named a moved symbol has to be pointed at where it went. */
const repointed = new Map<string, string>();
for (const file of every(join(root, "src")).concat(every(join(root, "tests")), every(join(root, "scripts")))) {
  if (file === path) continue;
  const text = readFileSync(file, "utf8");
  const theirs = importBlock(text.split("\n"));
  let changed = text;
  for (const statement of theirs.statements) {
    const from = /from\s+"([^"]+)"/.exec(statement);
    if (!from || !(from[1] as string).startsWith(".")) continue;
    if (resolve(dirname(file), (from[1] as string).replace(/\.js$/, ".ts")) !== path) continue;
    const names = importedNames([statement]);
    const moved = [...names].filter(([name]) => destination.has(name));
    if (moved.length === 0) continue;
    const kept = new Map([...names].filter(([name]) => !destination.has(name)));
    const grouped = new Map<string, Origin>();
    for (const [name, origin] of moved)
      grouped.set(name, {
        module: respecify(moduleName(destination.get(name) as string), directory, dirname(file)),
        clause: origin.clause,
      });
    changed = changed.replace(
      statement,
      [...importLines(kept), ...importLines(grouped)].join("\n") || "// removed by split-module",
    );
  }
  if (changed !== text) repointed.set(file, changed);
}

const say = (line: string) => process.stdout.write(`${line}\n`);
say(`${target}: ${lines.length} lines, ${cut.length} top-level declarations, reassembles exactly.`);
for (const [file, names] of plan) {
  const into = join(directory, file);
  say(`  ${file}  <- ${names.length} moved, ${(written.get(into) as string).split("\n").length} lines`);
  for (const line of importLines(
    needs(
      names.map((name) => byName.get(name) as Chunk),
      dirname(into),
      file,
    ),
  ))
    say(`      ${line}`);
}
say(`  ${target.split("/").pop()}  keeps ${staying.length}, ${(written.get(path) as string).split("\n").length} lines`);
for (const file of repointed.keys()) say(`  repointed ${relative(root, file)}`);

if (!write) {
  say("");
  say(
    "Nothing written. Pass --write, then `bun run check --fast` and, for anything a reader sees, `bun run rehearse`.",
  );
  process.exit(0);
}
for (const [file, text] of [...written, ...repointed]) writeFileSync(file, text);
say("");
say(`Written. Run \`bun run format\` to sort the imports, then \`bun run check --fast\`.`);
