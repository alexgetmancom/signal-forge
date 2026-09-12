/**
 * Layer boundaries, checked on the local import graph of src/.
 *
 * The rules themselves are not here: they live in .dependency-cruiser.jsonc, each with the reason
 * it exists written beside it. This file builds the graph and reports what the rules forbid.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sourceRoot = join(root, "src");

type Edge = { source: string; target: string };
type Selector = { path?: string; pathNot?: string; circular?: boolean };
type Rule = { name: string; comment?: string; from: Selector; to: Selector };

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && extname(entry.name) === ".ts") result.push(path);
  }
  return result;
}

function moduleName(file: string): string {
  return relative(root, file).split("/").join("/");
}

/**
 * The clause before `from` may not cross a quote. Written as `[\s\S]*?` it could, and then
 * `import "./delivery.js";` matched the *next* statement's specifier instead of its own: a
 * side-effect import was invisible to every rule below.
 */
function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const result = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g),
  ].map((match) => match[1] as string);
  result.push(...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] as string));
  return result;
}

function resolveLocal(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
  if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  return null;
}

/**
 * JSON with comments. The rules file is written for humans first, and the reason beside a rule is
 * the half that decides whether the rule survives its first inconvenient morning.
 */
function stripComments(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") lineComment = false;
      output += current === "\n" ? current : " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (quoted) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quoted = false;
      continue;
    }
    if (current === '"') {
      quoted = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      output += " ";
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      output += " ";
      continue;
    }
    output += current;
  }
  return output;
}

const rules: Rule[] = (
  JSON.parse(stripComments(readFileSync(join(root, ".dependency-cruiser.jsonc"), "utf8"))) as { forbidden: Rule[] }
).forbidden;

const files = walk(sourceRoot);
const edges: Edge[] = [];
for (const file of files) {
  for (const specifier of new Set(imports(file))) {
    const target = resolveLocal(file, specifier);
    if (target) edges.push({ source: moduleName(file), target: moduleName(target) });
  }
}

function cycles(): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.source, [...(graph.get(edge.source) ?? []), edge.target]);
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const found = new Set<string>();
  const result: string[][] = [];
  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (state.get(target) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(target)), target];
        const key = cycle.join(" -> ");
        if (!found.has(key)) {
          found.add(key);
          result.push(cycle);
        }
      } else if (!state.has(target)) visit(target);
    }
    stack.pop();
    state.set(node, "visited");
  };
  for (const file of files.map(moduleName)) if (!state.has(file)) visit(file);
  return result;
}

function matches(selector: Selector, module: string): boolean {
  if (selector.path && !new RegExp(selector.path).test(module)) return false;
  if (selector.pathNot && new RegExp(selector.pathNot).test(module)) return false;
  return true;
}

/**
 * Configuration is read once, validated once, in one place. A module reaching for `process.env`
 * directly is a setting that never appears in the schema, is never validated, and is discovered by
 * whoever deploys without it.
 */
function environmentReaders(): string[] {
  return files
    .map(moduleName)
    .filter((file) => file !== "src/config.ts")
    .filter((file) => /\bprocess\.env\b/.test(readFileSync(join(root, file), "utf8")))
    .map((file) => `only config.ts reads process.env: ${file}`);
}

const violations: string[] = [];
for (const rule of rules) {
  if (rule.to.circular) {
    violations.push(...cycles().map((cycle) => `${rule.name}: ${cycle.join(" -> ")}`));
    continue;
  }
  for (const edge of edges)
    if (matches(rule.from, edge.source) && matches(rule.to, edge.target))
      violations.push(`${rule.name}: ${edge.source} -> ${edge.target}`);
}
violations.push(...environmentReaders());

if (violations.length) {
  console.error(`Architecture checks failed:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `Architecture checks passed: ${files.length} modules, ${edges.length} local imports, ${rules.length} rules.`,
);
