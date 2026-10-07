/**
 * The local import graph of `src/`, read as text.
 *
 * Two checks need the same graph for opposite reasons. `check-architecture.ts` asks which edges
 * exist, so that a forbidden one fails the gate. `rehearsalNeeded.ts` asks the transitive question
 * -- what a replayed entry point can reach -- because that, and not a file's name, is what decides
 * whether a change can move what a replay measures.
 *
 * It was a hand-written list of names before, and the list was wrong in the direction that does not
 * fail: `standing.ts` holds the forty rules that decide who speaks and owed no rehearsal at all,
 * while `identity.ts` owed none on the morning a change to it merged fifty-two stories. 89 of the
 * 103 files reachable from a replayed root were unnamed. A name has to be remembered; an import
 * cannot be forgotten, because the code does not run without it.
 *
 * Not a parser, for the reason `moduleParts.ts` is not one: biome has already sorted every import
 * to the top of every file in this repository. What it does not know, it reports rather than skips.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

/** Every `.ts` file under a directory, as absolute paths. */
export function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && extname(entry.name) === ".ts") result.push(path);
  }
  return result;
}

/**
 * Every specifier a file imports, including the ones imported for their side effects.
 *
 * The clause before `from` may not cross a quote. Written as `[\s\S]*?` it could, and then
 * `import "./delivery.js";` matched the *next* statement's specifier instead of its own: a
 * side-effect import was invisible to every rule below.
 */
export function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const result = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g),
  ].map((match) => match[1] as string);
  result.push(...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] as string));
  return result;
}

/**
 * A relative specifier this cannot resolve is reported rather than skipped. A missed edge is a rule
 * that silently stops holding, which is worse than no rule at all: the gate still says it passed.
 */
export function resolveLocal(file: string, specifier: string): string | null {
  const base = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts"), base.replace(/\.ts$/, ".json")])
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  return null;
}

/** What each module under `src/` imports from this repository, as paths relative to the root. */
export function localGraph(root: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of walk(join(root, "src"))) {
    const targets: string[] = [];
    for (const specifier of new Set(imports(file))) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveLocal(file, specifier);
      if (target) targets.push(relative(root, target));
    }
    graph.set(relative(root, file), targets);
  }
  return graph;
}

/**
 * Every module the given ones reach, including themselves.
 *
 * Cycles are a fact of this graph rather than an error here -- `check-architecture.ts` is where
 * they are reported -- so a module already seen is not followed twice.
 */
export function reaches(graph: Map<string, readonly string[]>, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop() as string;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const target of graph.get(node) ?? []) pending.push(target);
  }
  return seen;
}
