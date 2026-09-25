/**
 * Render the same stored events twice and report every card a change would move.
 *
 * `replay-policy.ts` answers which cards are sent. This answers what they say, which is the other
 * half of "what reaches a reader" and had nothing measuring it: a change to the rendering passed
 * its tests and then went to a channel. Splitting discord.ts was the occasion -- 1201 lines claimed
 * to move unchanged, and the only honest way to claim that is to render real history under both
 * trees and compare the bytes. 8015 cards, one hash.
 *
 * What it does not cover: the context a card is assembled with -- what else was in the batch, what
 * another catalogue lent it, which venues also carry it -- is built while batching and is not
 * stored. Every event is rendered on its own, with a fixed link. That is the rendering and not the
 * pipeline, which is the part a change to this folder changes.
 *
 * The base tree is unpacked from git into a temporary directory; nothing in the repository or its
 * refs is touched, and the database is opened read-only.
 *
 * Usage: bun scripts/replay-cards.ts [--db path] [--base ref|directory] [--days N] [--limit N]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Event } from "../src/events/types.js";

type Detail = "brief" | "evidence";
type Render = (event: Event, url: string, summary?: string, detail?: Detail) => Record<string, unknown>;

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) args.set(Bun.argv[index] ?? "", Bun.argv[index + 1] ?? "");
const dbPath = args.get("--db") ?? "./data/app.db";
const base = args.get("--base") ?? "HEAD";
const days = Number(args.get("--days") ?? 30);
const limit = Number(args.get("--limit") ?? 20);

/** The link is fixed on purpose: a card's own URL is a fact about the event, not about the change. */
const LINK = "https://example.invalid/rehearsal";

async function renderAt(ref: string, workspace: string): Promise<Render> {
  if (existsSync(join(ref, "src/events/render/discord.ts"))) return load(resolve(ref), ref);
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(["tar", "-x", "-C", workspace], { stdin: archive.stdout });
  if (!unpack.success) throw new Error(`Unpacking ${ref} failed`);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  return load(workspace, ref);
}

async function load(directory: string, ref: string): Promise<Render> {
  const module = (await import(join(directory, "src/events/render/discord.ts"))) as { eventEmbed?: Render };
  if (!module.eventEmbed) throw new Error(`${ref} has no eventEmbed; choose a later base`);
  return module.eventEmbed;
}

/** A card that threw is a finding, not a crash: the comparison is the point, so it is recorded. */
function render(embed: Render, event: Event, detail: Detail): string {
  try {
    return JSON.stringify(embed(event, LINK, undefined, detail));
  } catch (error) {
    return JSON.stringify({ threw: error instanceof Error ? error.message : String(error) });
  }
}

/** The first line that differs, which is what a reader would have noticed. */
function firstDifference(was: string, now: string): string {
  const one = JSON.parse(was) as Record<string, unknown>;
  const two = JSON.parse(now) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(one), ...Object.keys(two)])];
  const moved = keys.filter((key) => JSON.stringify(one[key]) !== JSON.stringify(two[key]));
  return moved
    .slice(0, 3)
    .map(
      (key) =>
        `    ${key}: ${String(JSON.stringify(one[key])).slice(0, 90)}\n      -> ${String(JSON.stringify(two[key])).slice(0, 90)}`,
    )
    .join("\n");
}

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-cards-"));
try {
  const before = await renderAt(base, workspace);
  const after = ((await import("../src/events/render/discord.js")) as { eventEmbed: Render }).eventEmbed;
  const db = new Database(dbPath, { readonly: true });
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const events = db.query<Event, [string]>("SELECT * FROM events WHERE detected_at>=? ORDER BY id").all(since);

  const changed: { event: Event; detail: Detail; was: string; now: string }[] = [];
  const digest = { was: createHash("sha256"), now: createHash("sha256") };
  let cards = 0;
  for (const event of events)
    for (const detail of ["brief", "evidence"] as const) {
      const was = render(before, event, detail);
      const now = render(after, event, detail);
      digest.was.update(was);
      digest.now.update(now);
      cards += 1;
      if (was !== now) changed.push({ event, detail, was, now });
    }

  const title = (event: Event): string => {
    const record = JSON.parse(event.after_json ?? event.before_json ?? "{}") as { name?: unknown };
    return String(record.name ?? event.entity_id).slice(0, 80);
  };
  process.stdout.write(
    `${[
      `Card replay: ${base} -> working tree, ${days} days, ${events.length} events rendered at both detail levels`,
      `cards: ${cards}`,
      `cards changed: ${changed.length}`,
      changed.length ? "" : `identical, sha256 ${digest.was.digest("hex").slice(0, 16)} on both sides`,
      "",
      ...changed
        .slice(0, limit)
        .map(
          ({ event, detail, was, now }) =>
            `#${event.id} [${event.source}] ${title(event)} (${detail})\n${firstDifference(was, now)}`,
        ),
      ...(changed.length > limit ? [`... and ${changed.length - limit} more (--limit)`] : []),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")}\n`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
