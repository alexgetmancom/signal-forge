import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sourceRoot = join(root, "src");

type Edge = { source: string; target: string };
type Rule = { name: string; from: RegExp; to: RegExp };

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

function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const result = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g),
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

const rules: Rule[] = [
  { name: "collectors cannot import delivery", from: /^src\/sources\//, to: /^src\/delivery\.ts$/ },
  { name: "collectors cannot import renderers", from: /^src\/sources\//, to: /^src\/events\/render\// },
  { name: "storage cannot import collectors", from: /^src\/storage\//, to: /^src\/sources\// },
  { name: "storage cannot import transport adapters", from: /^src\/storage\//, to: /^src\/(delivery|http)\.ts$/ },
  { name: "event persistence cannot import renderers", from: /^src\/events\/store\.ts$/, to: /^src\/events\/render\// },
  {
    name: "renderers cannot import collectors",
    from: /^src\/events\/render\//,
    to: /^src\/sources\/(?!labels\.ts$)/,
  },
  { name: "renderers cannot import delivery", from: /^src\/events\/render\//, to: /^src\/delivery\.ts$/ },
  { name: "delivery cannot import collectors", from: /^src\/delivery\.ts$/, to: /^src\/sources\// },
  { name: "event core cannot import HTTP framework", from: /^src\/events\//, to: /^src\/http\.ts$/ },
];

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

const violations = cycles().map((cycle) => `circular import: ${cycle.join(" -> ")}`);
violations.push(...environmentReaders());
for (const rule of rules)
  for (const edge of edges)
    if (rule.from.test(edge.source) && rule.to.test(edge.target))
      violations.push(`${rule.name}: ${edge.source} -> ${edge.target}`);

if (violations.length) {
  console.error(`Architecture checks failed:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  process.exit(1);
}

console.log(`Architecture checks passed: ${files.length} modules, ${edges.length} local imports.`);
