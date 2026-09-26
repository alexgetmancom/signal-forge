import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { eventEmbed } from "../events/render/discord.js";
import type { Event } from "../events/types.js";
import { readRuntime } from "../runtime/observability.js";
import { readState, writeState } from "../storage/appState.js";

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
 *
 * And the events are fixed too, which is the whole difference between a comparison and a number.
 * The first version measured the window from whenever it was asked, so two boots of the same code
 * two hours apart hashed two different sets of events and disagreed: the first deploy to use it
 * reported a change no build had made. A fingerprint of the build has to be taken over a corpus
 * that does not move, so the corpus is decided once -- a lower bound on when, an upper bound on
 * which -- stored, and reused until it ages out.
 */
const LINK = "https://example.invalid/verify";
const DETAILS = ["brief", "evidence"] as const;
const CORPUS_KEY = "release_render_corpus";
/**
 * When a fixed corpus stops being worth keeping fixed.
 *
 * Its cards are immutable, so an old corpus keeps answering the question correctly; what it stops
 * doing is covering the kinds of card the service has learned to make since. A month is long enough
 * that a run of deploys is compared against itself and short enough that the corpus still looks
 * like what the channel is sending. Re-anchoring costs the comparison once, and says so by leaving
 * `previous` empty rather than by reporting a difference.
 */
const CORPUS_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** The events a fingerprint is taken over: everything since `since`, up to and including `maxId`. */
type Corpus = { since: string; maxId: number; windowDays: number };

/** `corpus` as stored on a row, so two rows are only ever compared when they hashed the same events. */
function corpusId(corpus: Corpus): string {
  return `${corpus.since}|${corpus.maxId}`;
}

/**
 * The corpus every boot of this deployment uses, decided by whichever boot asked first.
 *
 * Re-anchored when it is older than a month or when a different window is asked for, and never
 * otherwise: the point of it is that it is the same events today as it was at the last deploy.
 */
export function releaseCorpus(db: Database, windowDays: number, now = Date.now()): Corpus {
  const stored = readState(db, CORPUS_KEY);
  if (stored) {
    const held = JSON.parse(stored) as Corpus;
    const fresh = Date.parse(held.since) >= now - CORPUS_MAX_AGE_MS;
    if (fresh && held.windowDays === windowDays) return held;
  }
  const at = new Date(now).toISOString();
  const maxId =
    db.query<{ id: number | null }, [string]>("SELECT MAX(id) id FROM events WHERE detected_at<?").get(at)?.id ?? 0;
  const corpus: Corpus = { since: new Date(now - windowDays * 24 * 3_600_000).toISOString(), maxId, windowDays };
  writeState(db, CORPUS_KEY, JSON.stringify(corpus));
  return corpus;
}

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

export function renderFingerprint(db: Database, corpus: Corpus): { hash: string; cards: number; tookMs: number } {
  const started = Date.now();
  const events = db
    .query<Event, [string, number]>("SELECT * FROM events WHERE detected_at>=? AND id<=? ORDER BY id")
    .all(corpus.since, corpus.maxId);
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

type Row = {
  boot_id: string;
  booted_at: string;
  hash: string;
  cards: number;
  window_days: number;
  took_ms: number;
  corpus: string | null;
};

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
  const corpus = releaseCorpus(db, windowDays, now);
  const id = corpusId(corpus);
  const existing = db.query<Row, [string]>("SELECT * FROM release_renders WHERE boot_id=?").get(runtime.bootId);
  const stale = !existing || existing.corpus !== id;
  const current = stale
    ? renderFingerprint(db, corpus)
    : { hash: existing.hash, cards: existing.cards, tookMs: existing.took_ms };
  if (stale)
    db.query(
      `INSERT INTO release_renders(boot_id,computed_at,booted_at,hash,cards,window_days,took_ms,corpus)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(boot_id) DO UPDATE SET
         computed_at=excluded.computed_at, hash=excluded.hash, cards=excluded.cards,
         window_days=excluded.window_days, took_ms=excluded.took_ms, corpus=excluded.corpus`,
    ).run(
      runtime.bootId,
      new Date(now).toISOString(),
      runtime.bootedAt,
      current.hash,
      current.cards,
      windowDays,
      current.tookMs,
      id,
    );

  // Only boots that hashed the same events. A row taken over another corpus is not a disagreement
  // and is not an agreement either; it is a different question, and answering with it is what the
  // moving window did.
  const earlier = db
    .query<Row, [string, string]>(
      "SELECT * FROM release_renders WHERE booted_at<? AND corpus=? ORDER BY booted_at DESC LIMIT 40",
    )
    .all(runtime.bootedAt, id);
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
