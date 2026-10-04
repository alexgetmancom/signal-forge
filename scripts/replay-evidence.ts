/**
 * Derive everything from every stored event, twice, and report every reader a change moved.
 *
 * The three replays beside this one cover what reaches a reader: which cards are sent, what they
 * say, what a report answers. None of them covers the form of the evidence those answers are drawn
 * from. An event's `before_json` and `after_json` are a stored representation, and on 2026-10-03 I
 * changed that representation -- a web change now stores the strings that changed instead of the
 * page they changed in, which took the events table from 47 MB to 16 MB.
 *
 * The argument that it was safe was that all fourteen readers of `.strings` consume only the diff.
 * The argument was right and incomplete. A throwaway script that rendered all 243 affected events
 * through eight views, before and after, found five that moved: formatting-only changes whose diff
 * is empty, where `summaryMaterial` fell through to dumping both whole pages. Nothing observable
 * had moved, because no summary had ever been asked for those five, so the tests passed, the gate
 * passed, both card replays passed, and I would have reported "nothing changes" and been wrong in
 * five of 243 cases. The script that caught it was deleted the same afternoon.
 *
 * So this is that script, kept. Every event in the database, through every reader that consumes a
 * stored body, under the base tree and under the working tree, compared. The views are named rather
 * than discovered: a reader that stops being measured and a reader that was never measured read the
 * same, so adding one here is part of adding one there.
 *
 * It is not the card replay with more rows. `replay-cards` asks what a card says over a window of
 * recent events; this asks what every reader derives from every event ever stored, including the
 * readers no card goes through -- the summariser's material, the attachment a message carries, and
 * the classifiers that decide whether an event is a sighting at all.
 *
 * Reads only, on both ends, and the copy is opened read-only.
 *
 * Usage: bun scripts/replay-evidence.ts [--db path] [--base ref|directory] [--limit N] [--result path]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DATABASE_URL } from "../src/config.js";
import { refuseTheMissingDefault } from "../src/storage/database.js";

type Event = Record<string, unknown>;
/** One named derivation of a stored body. A view that throws is recorded as throwing, not skipped. */
type View = { name: string; of: (event: Event) => unknown };

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) args.set(Bun.argv[index] ?? "", Bun.argv[index + 1] ?? "");
const dbPath = args.get("--db") ?? DEFAULT_DATABASE_URL;
// There is no local database: say so rather than building an empty one and replaying into it.
refuseTheMissingDefault(dbPath);
const base = args.get("--base") ?? "HEAD";
const shown = base.includes("/") ? (base.split("/").pop() as string).slice(0, 12) : base;
const limit = Number(args.get("--limit") ?? 10);
const result = args.get("--result");

/** Ages appear in rendered evidence, so both trees are asked at one instant. */
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

/**
 * The readers of a stored body, in one place.
 *
 * `summaryMaterial` is first because it is the one that moved and the one nothing else covers: no
 * card renders it, so a card replay cannot see it. The classifiers answer a boolean each, which is
 * the cheapest thing to compare and the most expensive to get wrong -- `signalClass` decides
 * whether an event is a sighting, and an event that stops being one is never rendered at all.
 */
async function viewsOf(directory: string): Promise<View[]> {
  const at = (file: string) => import(join(directory, file));
  const [summary, attachment, signals, common] = await Promise.all([
    at("src/summary/events.ts"),
    at("src/events/render/attachment.ts"),
    at("src/events/signals.ts"),
    at("src/events/render/common.ts"),
  ]);
  const strings = (json: unknown): unknown => {
    if (typeof json !== "string") return [];
    try {
      const parsed = JSON.parse(json) as { strings?: unknown };
      return Array.isArray(parsed?.strings) ? parsed.strings : [];
    } catch {
      return [];
    }
  };
  return [
    { name: "summaryMaterial", of: (event) => summary.summaryMaterial(event) },
    { name: "eventAttachment", of: (event) => attachment.eventAttachment(event) },
    { name: "signalClass", of: (event) => signals.signalClass(event) },
    { name: "isModelSighting", of: (event) => signals.isModelSighting(event) },
    { name: "pingWorthy", of: (event) => signals.pingWorthy(event) },
    { name: "webChangeSaysItShipped", of: (event) => common.webChangeSaysItShipped(event) },
    {
      name: "webStringChanges",
      of: (event) => common.webStringChanges(strings(event.before_json), strings(event.after_json)),
    },
  ];
}

async function treeAt(ref: string, workspace: string): Promise<View[]> {
  if (existsSync(join(ref, "src/summary/events.ts"))) return viewsOf(resolve(ref));
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(["tar", "-x", "-C", workspace], { stdin: archive.stdout });
  if (!unpack.success) throw new Error(`Unpacking ${ref} failed`);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  return viewsOf(workspace);
}

/** What one tree derives from one event, per view, as comparable text. */
function derive(views: View[], event: Event): Map<string, string> {
  const out = new Map<string, string>();
  for (const view of views) {
    try {
      out.set(view.name, JSON.stringify(view.of(event)) ?? "undefined");
    } catch (error) {
      out.set(view.name, JSON.stringify({ threw: error instanceof Error ? error.message : String(error) }));
    }
  }
  return out;
}

/** The two values shown from where they start to disagree, as in `replay-reports`. */
function around(was: string, now: string, width = 120): string {
  let at = 0;
  while (at < was.length && at < now.length && was[at] === now[at]) at += 1;
  const from = Math.max(0, at - 20);
  const show = (text: string) => `${from > 0 ? "..." : ""}${text.slice(from, from + width)}`;
  return `      ${show(was)}\n      -> ${show(now)}`;
}

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-evidence-"));
try {
  const db = new Database(dbPath, { readonly: true });
  const before = await treeAt(base, workspace);
  const after = await viewsOf(root);
  const events = db.query<Event, []>("SELECT * FROM events ORDER BY id").all();

  const moved: { id: number; source: string; view: string; was: string; now: string }[] = [];
  const perView = new Map<string, number>();
  const digest = createHash("sha256");
  for (const event of events) {
    const was = derive(before, event);
    const now = derive(after, event);
    for (const [view, value] of now) {
      digest.update(`${view}\u0000${value}\u0000`);
      const old = was.get(view) ?? "absent";
      if (old === value) continue;
      perView.set(view, (perView.get(view) ?? 0) + 1);
      moved.push({ id: Number(event.id), source: String(event.source), view, was: old, now: value });
    }
  }
  const fingerprint = digest.digest("hex").slice(0, 16);

  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`${events.length} events, ${after.length} views each, ${shown} against the working tree.`);
  if (moved.length === 0) say(`No reader of a stored body moved. Fingerprint ${fingerprint}.`);
  else {
    say(`${moved.length} derivations moved across ${perView.size} views. Fingerprint ${fingerprint}.`);
    for (const [view, count] of [...perView].sort((one, two) => two[1] - one[1])) say(`  ${count} in ${view}`);
    for (const one of moved.slice(0, limit)) {
      say(`  event ${one.id} (${one.source}) ${one.view}:`);
      say(around(one.was, one.now));
    }
    if (moved.length > limit) say(`  ... and ${moved.length - limit} more`);
  }
  db.close();

  if (result)
    writeFileSync(
      result,
      JSON.stringify({
        phase: "evidence",
        verdict: moved.length === 0 ? "same" : "moved",
        moved: moved.length,
        fingerprint,
      }),
    );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
