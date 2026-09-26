/**
 * Answer every question the service can be asked, twice, and report every answer a change moved.
 *
 * `replay-policy` covers which cards are sent and `replay-cards` covers what they say. Neither
 * covers the other half of what this repository is: the operations. A report is read by a person
 * making a decision, and a change to its wording, its ordering or its arithmetic reaches that
 * person exactly as directly as a card reaches a channel -- with nothing measuring it. The tests
 * have been standing in for the measurement, which is why 249 of their assertions are substrings
 * of prose: the only way to notice a report changed was to have written down a sentence it used to
 * contain, and every improvement to that sentence then failed a test that was not about it.
 *
 * So the reports get what the cards have. Every read-only operation is called with its defaults
 * against the same copy of production, under the base tree and under the working tree, and the
 * JSON is compared. A change that moves nothing says so in one line; a change that moves something
 * names the operation and the first field that differs, which is the sentence to read before
 * pushing rather than the test to fix afterwards.
 *
 * Determinism is arranged rather than hoped for. The clock is frozen at the same instant on both
 * sides -- `Date.now` and a bare `new Date()`, because half these reports measure ages -- and any
 * operation that reaches the network is skipped rather than run against an upstream that has moved
 * between the two passes. An operation that needs an argument is skipped too: there is no honest
 * default for "which source", and inventing one measures the invention. The copy is opened
 * read-only, so an operation that caches its answer on first ask -- `verify` computes a render
 * fingerprint once per boot and writes it down -- is skipped by the same rule: what it would
 * measure is the write, not the change. Every skip is named rather than counted, because a report
 * that quietly stopped being measured and one that was never measured read the same.
 *
 * Usage: bun scripts/replay-reports.ts [--db path] [--base ref|directory] [--limit N] [--result path]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Definition = {
  mutates: boolean;
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
  handler: (input: never) => unknown;
};
type Registry = Record<string, Definition>;
type Tree = { operations: (db: Database, config: unknown) => Registry; loadConfig: () => unknown };

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) args.set(Bun.argv[index] ?? "", Bun.argv[index + 1] ?? "");
const dbPath = args.get("--db") ?? "./data/app.db";
const base = args.get("--base") ?? "HEAD";
const shown = base.includes("/") ? (base.split("/").pop() as string).slice(0, 12) : base;
const limit = Number(args.get("--limit") ?? 12);
const result = args.get("--result");

/** The instant both trees are asked at. A report that measures an age must measure the same age. */
const FIXED = Date.now();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...input: unknown[]) {
    if (input.length === 0) super(FIXED);
    else super(...(input as [number]));
  }
  static override now(): number {
    return FIXED;
  }
}
globalThis.Date = FrozenDate as DateConstructor;
// An operation that would reach out is measured against an upstream, not against the change.
const unreachable = (() => {
  throw new Error("reaches the network");
}) as unknown as typeof fetch;
globalThis.fetch = unreachable;

async function treeAt(ref: string, workspace: string): Promise<Tree> {
  if (existsSync(join(ref, "src/operations.ts"))) return load(resolve(ref));
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(["tar", "-x", "-C", workspace], { stdin: archive.stdout });
  if (!unpack.success) throw new Error(`Unpacking ${ref} failed`);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  return load(workspace);
}

async function load(directory: string): Promise<Tree> {
  const registry = (await import(join(directory, "src/operations.ts"))) as { operations: Tree["operations"] };
  const config = (await import(join(directory, "src/config.ts"))) as { loadConfig: Tree["loadConfig"] };
  return { operations: registry.operations, loadConfig: config.loadConfig };
}

/** An answer, or why this pass did not ask for one. Exactly one of the two is set. */
type Answer = { json: string } | { skipped: string };

/** Why an operation that threw was not asked, rather than an answer of "it threw". */
function unaskable(message: string): string | null {
  if (message.includes("reaches the network")) return "reaches out";
  if (message.includes("readonly database")) return "writes on first ask";
  return null;
}

/** What one tree answers, keyed by operation. */
async function answers(tree: Tree, db: Database): Promise<Map<string, Answer>> {
  const config = tree.loadConfig();
  const defs = tree.operations(db, config);
  const out = new Map<string, Answer>();
  for (const [name, definition] of Object.entries(defs)) {
    const parsed = definition.schema.safeParse({});
    if (definition.mutates || !parsed.success) {
      out.set(name, { skipped: definition.mutates ? "mutates" : "argument needed" });
      continue;
    }
    try {
      const value = await (definition.handler as (input: unknown) => unknown)(parsed.data);
      out.set(name, { json: JSON.stringify(value) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const why = unaskable(message);
      out.set(name, why ? { skipped: why } : { json: JSON.stringify({ threw: message }) });
    }
  }
  return out;
}

/** The skipped operations, gathered under the reason they were skipped. */
function skipList(all: Map<string, Answer>): string[] {
  const groups = new Map<string, string[]>();
  for (const [name, answer] of all)
    if ("skipped" in answer) groups.set(answer.skipped, [...(groups.get(answer.skipped) ?? []), name]);
  return [...groups]
    .sort((one, two) => two[1].length - one[1].length)
    .map(([why, names]) => `  ${names.length} ${why}: ${names.sort().join(", ")}`);
}

/**
 * The first fields that differ, which is what a reader would have noticed.
 *
 * A list is turned into a record keyed by position first. The version that summarised a list as its
 * length and its first element printed the name of the operation and nothing else whenever the
 * fifth row was the one that moved, which is the shape most of these answers have.
 */
function firstDifference(was: string, now: string): string {
  const parse = (text: string): Record<string, unknown> => {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? Object.fromEntries(value.map((item, index) => [`[${index}]`, item]))
      : (value as Record<string, unknown>);
  };
  const one = parse(was);
  const two = parse(now);
  const keys = [...new Set([...Object.keys(one), ...Object.keys(two)])];
  return keys
    .filter((key) => JSON.stringify(one[key]) !== JSON.stringify(two[key]))
    .slice(0, 3)
    .map((key) => `    ${key}:\n${around(JSON.stringify(one[key]) ?? "", JSON.stringify(two[key]) ?? "")}`)
    .join("\n");
}

/**
 * The two values shown from where they start to disagree.
 *
 * Printed from the beginning, a difference in the last field of a long row is two identical lines:
 * every answer here is JSON and most of it is the part that did not move.
 */
function around(was: string, now: string, width = 100): string {
  let at = 0;
  while (at < was.length && at < now.length && was[at] === now[at]) at += 1;
  const from = Math.max(0, at - 20);
  const show = (text: string) => `${from > 0 ? "..." : ""}${text.slice(from, from + width)}`;
  return `      ${show(was)}\n      -> ${show(now)}`;
}

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-reports-"));
try {
  const db = new Database(dbPath, { readonly: true });
  const before = await answers(await treeAt(base, workspace), db);
  const after = await answers(await load(root), db);

  const said = (all: Map<string, Answer>, name: string): string | null => {
    const answer = all.get(name);
    return answer && "json" in answer ? answer.json : null;
  };
  const asked = [...after.keys()].filter((name) => said(after, name) !== null && said(before, name) !== null).sort();
  const changed = asked.filter((name) => said(before, name) !== said(after, name));
  const digest = createHash("sha256");
  for (const name of asked) digest.update(`${name}:${said(after, name)}`);

  process.stdout.write(
    `${[
      `Report replay: ${shown} -> working tree, ${asked.length} operations asked`,
      ...skipList(after),
      `answers changed: ${changed.length}`,
      changed.length ? "" : `identical, sha256 ${digest.digest("hex").slice(0, 16)}`,
      "",
      ...changed
        .slice(0, limit)
        .map((name) => `${name}\n${firstDifference(said(before, name) as string, said(after, name) as string)}`),
      ...(changed.length > limit ? [`... and ${changed.length - limit} more (--limit)`] : []),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")}\n`,
  );
  if (result)
    writeFileSync(
      result,
      JSON.stringify({
        phase: "reports",
        verdict: changed.length === 0 ? "same" : "moved",
        moved: changed.length,
        fingerprint: createHash("sha256")
          .update(asked.map((name) => `${name}:${said(after, name)}`).join("\n"))
          .digest("hex"),
      }),
    );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
