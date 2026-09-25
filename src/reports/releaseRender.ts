import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { eventEmbed } from "../events/render/discord.js";
import type { Event } from "../events/types.js";
import { readRuntime } from "../runtime/observability.js";

/**
 * What this build renders, as one number, so a deploy can be asked whether it changed a card.
 *
 * `rehearse` answers this before a push: every event in a window rendered at both detail levels,
 * reduced to one sha256, compared against the same thing at a base ref. It answers it on a laptop
 * against a copy, and nothing carried the answer across. `verify` could say the image is new --
 * the symbol is in /app/dist -- and could not say whether the new image says anything different
 * to a reader, which is the only part of a release anybody outside this repository experiences.
 *
 * Two days rather than thirty: after a deploy that is the window whose cards are still on screen,
 * and it is the difference between half a second and five. The link is fixed because a card's own
 * URL is a fact about the event and not about the build.
 */
const LINK = "https://example.invalid/verify";
const DETAILS = ["brief", "evidence"] as const;

export type RenderFingerprint = {
  hash: string;
  cards: number;
  windowDays: number;
  tookMs: number;
  /** The boot this build's rendering last differed from, and what it said then. */
  previous: { bootedAt: string; hash: string } | null;
  /** How far back the same hash goes, which is the useful claim: these builds moved no card. */
  unchangedSince: string | null;
};

export function renderFingerprint(
  db: Database,
  windowDays: number,
  now = Date.now(),
): { hash: string; cards: number; tookMs: number } {
  const started = Date.now();
  const since = new Date(now - windowDays * 24 * 3_600_000).toISOString();
  const events = db.query<Event, [string]>("SELECT * FROM events WHERE detected_at>=? ORDER BY id").all(since);
  const digest = createHash("sha256");
  let cards = 0;
  for (const event of events)
    for (const detail of DETAILS) {
      // A card that throws is part of the fingerprint too: a build that started throwing where the
      // last one did not has changed what reaches a reader, and hiding it would say it had not.
      try {
        digest.update(JSON.stringify(eventEmbed(event, LINK, undefined, detail)));
      } catch (error) {
        digest.update(`threw:${error instanceof Error ? error.message : "unknown"}`);
      }
      cards += 1;
    }
  return { hash: digest.digest("hex"), cards, tookMs: Date.now() - started };
}

type Row = { boot_id: string; booted_at: string; hash: string; cards: number; window_days: number; took_ms: number };

/**
 * The fingerprint for the running boot, computed once and read afterwards.
 *
 * Paid by whoever is watching the deploy, which is the only person who wants it, and never by the
 * poller. A boot with no recorded start time is a process that has not finished starting, and gets
 * no row rather than a row keyed on nothing.
 */
export function releaseRender(db: Database, windowDays = 2, now = Date.now()): RenderFingerprint | null {
  const runtime = readRuntime(db);
  if (!runtime) return null;
  const existing = db.query<Row, [string]>("SELECT * FROM release_renders WHERE boot_id=?").get(runtime.bootId);
  const current =
    existing && existing.window_days === windowDays
      ? { hash: existing.hash, cards: existing.cards, tookMs: existing.took_ms }
      : renderFingerprint(db, windowDays, now);
  if (!existing || existing.window_days !== windowDays)
    db.query(
      `INSERT INTO release_renders(boot_id,computed_at,booted_at,hash,cards,window_days,took_ms)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(boot_id) DO UPDATE SET
         computed_at=excluded.computed_at, hash=excluded.hash, cards=excluded.cards,
         window_days=excluded.window_days, took_ms=excluded.took_ms`,
    ).run(
      runtime.bootId,
      new Date(now).toISOString(),
      runtime.bootedAt,
      current.hash,
      current.cards,
      windowDays,
      current.tookMs,
    );

  const earlier = db
    .query<Row, [string, number]>(
      "SELECT * FROM release_renders WHERE booted_at<? AND window_days=? ORDER BY booted_at DESC LIMIT 40",
    )
    .all(runtime.bootedAt, windowDays);
  const lastDifferent = earlier.find((row) => row.hash !== current.hash) ?? null;
  // The run of boots before this one that said the same thing. Its oldest is the claim worth
  // making: no build since then has moved a card, whatever else those builds changed.
  const agreeing = lastDifferent ? earlier.slice(0, earlier.indexOf(lastDifferent)) : earlier;
  return {
    hash: current.hash,
    cards: current.cards,
    windowDays,
    tookMs: current.tookMs,
    previous: lastDifferent ? { bootedAt: lastDifferent.booted_at, hash: lastDifferent.hash } : null,
    unchangedSince: agreeing.at(-1)?.booted_at ?? (earlier.length === 0 ? null : runtime.bootedAt),
  };
}
