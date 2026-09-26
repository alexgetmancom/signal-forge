import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { eventEmbed } from "../events/render/discord.js";
import type { Event } from "../events/types.js";
import { readRuntime } from "../runtime/observability.js";
import { readState, writeState } from "../storage/appState.js";

/**
 * What this build renders, as one number and a list, so a deploy can be asked what it changed.
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
 *
 * The hash alone stops one question short. A watcher who reads that it changed has to reproduce
 * the rehearsal locally to find out what changed, so every card is hashed on its own as well and
 * the boot that disagrees is subtracted from the boot before it: `changed` names the events.
 */
const LINK = "https://example.invalid/verify";
const DETAILS = ["brief", "evidence"] as const;
/** Per-event hashes are kept for this many of the most recent boots; the diff never reaches past them. */
const KEEP_CARDS_FOR_BOOTS = 5;
/** Events named in `changed`. The rest are a count: a list nobody reads is not a diagnosis. */
const SAMPLE = 5;
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
 * Where a window's corpus is stored. The window is part of the key: one caller asking for sixty
 * days must not silently re-anchor the two-day corpus every other caller is being compared against.
 */
function corpusKey(windowDays: number): string {
  return `release_render_corpus:${windowDays}`;
}

/**
 * The corpus every boot of this deployment uses, decided by whichever boot asked first.
 *
 * Re-anchored when it is older than a month, and never otherwise: the point of it is that it is
 * the same events today as it was at the last deploy.
 */
export function releaseCorpus(db: Database, windowDays: number, now = Date.now()): Corpus {
  const stored = readState(db, corpusKey(windowDays));
  if (stored) {
    const held = JSON.parse(stored) as Corpus;
    if (Date.parse(held.since) >= now - CORPUS_MAX_AGE_MS) return held;
  }
  const at = new Date(now).toISOString();
  const maxId =
    db.query<{ id: number | null }, [string]>("SELECT MAX(id) id FROM events WHERE detected_at<?").get(at)?.id ?? 0;
  const corpus: Corpus = { since: new Date(now - windowDays * 24 * 3_600_000).toISOString(), maxId, windowDays };
  writeState(db, corpusKey(windowDays), JSON.stringify(corpus));
  return corpus;
}

/** One event's cards, as the eight hex characters a diff compares. */
function cardHash(event: Event): string {
  const digest = createHash("sha256");
  // A card that throws is part of the fingerprint too: a build that started throwing where the
  // last one did not has changed what reaches a reader, and hiding it would say it had not. The
  // class, not the message: a message carrying a timestamp or an id would differ every boot and
  // report a change no build had made, which is the mistake the fixed corpus exists to avoid.
  for (const detail of DETAILS)
    try {
      digest.update(JSON.stringify(eventEmbed(event, LINK, undefined, detail)));
    } catch (error) {
      digest.update(`threw:${error instanceof Error ? error.name : "unknown"}`);
    }
  return digest.digest("hex").slice(0, 16);
}

export type Fingerprint = { hash: string; cards: number; tookMs: number; byEvent: Map<number, string> };

export function renderFingerprint(db: Database, corpus: Corpus): Fingerprint {
  const started = Date.now();
  const events = db
    .query<Event, [string, number]>("SELECT * FROM events WHERE detected_at>=? AND id<=? ORDER BY id")
    .all(corpus.since, corpus.maxId);
  const digest = createHash("sha256");
  const byEvent = new Map<number, string>();
  for (const event of events) {
    const hash = cardHash(event);
    byEvent.set(event.id, hash);
    digest.update(hash);
  }
  return { hash: digest.digest("hex"), cards: events.length * DETAILS.length, tookMs: Date.now() - started, byEvent };
}

/** The cards of one boot, as they were hashed then. */
function cardsOf(db: Database, bootId: string): Map<number, string> {
  const rows = db
    .query<{ event_id: number; hash: string }, [string]>(
      "SELECT event_id,hash FROM release_render_cards WHERE boot_id=?",
    )
    .all(bootId);
  return new Map(rows.map((row) => [row.event_id, row.hash]));
}

function storeCards(db: Database, bootId: string, byEvent: Map<number, string>): void {
  const insert = db.query("INSERT OR REPLACE INTO release_render_cards(boot_id,event_id,hash) VALUES(?,?,?)");
  db.transaction(() => {
    for (const [eventId, hash] of byEvent) insert.run(bootId, eventId, hash);
  })();
  db.query(
    `DELETE FROM release_render_cards WHERE boot_id NOT IN
       (SELECT boot_id FROM release_renders ORDER BY booted_at DESC LIMIT ?)`,
  ).run(KEEP_CARDS_FOR_BOOTS);
}

/** Which events this build renders differently from the boot it last differed from. */
type ChangedCards = { events: number; sample: { eventId: number; source: string; entityId: string }[] };

function changedCards(db: Database, current: Map<number, string>, againstBoot: string): ChangedCards | null {
  const before = cardsOf(db, againstBoot);
  // No stored cards is not "nothing changed": the boot aged out of KEEP_CARDS_FOR_BOOTS and the
  // question cannot be answered, which `null` says and an empty list would not.
  if (before.size === 0) return null;
  const ids = [...current.keys()].filter((id) => current.get(id) !== before.get(id));
  const sample = ids.slice(0, SAMPLE).map((eventId) => {
    const row = db
      .query<{ source: string; entity_id: string }, [number]>("SELECT source,entity_id FROM events WHERE id=?")
      .get(eventId);
    return { eventId, source: row?.source ?? "gone", entityId: row?.entity_id ?? "gone" };
  });
  return { events: ids.length, sample };
}

export type RenderFingerprint = {
  hash: string;
  cards: number;
  windowDays: number;
  tookMs: number;
  /** The boot this build's rendering last differed from, and what it said then. */
  previous: { bootedAt: string; hash: string } | null;
  /** Which cards that difference is, when the boot it differs from still has its own. */
  changed: ChangedCards | null;
  /** How far back the same hash goes, which is the useful claim: these builds moved no card. */
  unchangedSince: string | null;
};

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
 * This boot's numbers: read back if it already rendered this corpus, computed and stored if not.
 *
 * `byEvent` is null on the read-back path because the cards are already a table; the diff reads
 * them from there rather than rendering nine hundred embeds to learn what it wrote down last time.
 */
function thisBoot(
  db: Database,
  runtime: { bootId: string; bootedAt: string },
  corpus: Corpus,
  stored: Row | null,
  now: number,
): { hash: string; cards: number; tookMs: number; byEvent: Map<number, string> | null } {
  if (stored) return { hash: stored.hash, cards: stored.cards, tookMs: stored.took_ms, byEvent: null };
  const fresh = renderFingerprint(db, corpus);
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
    fresh.hash,
    fresh.cards,
    corpus.windowDays,
    fresh.tookMs,
    corpusId(corpus),
  );
  storeCards(db, runtime.bootId, fresh.byEvent);
  return fresh;
}

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
  const row = db.query<Row, [string]>("SELECT * FROM release_renders WHERE boot_id=?").get(runtime.bootId);
  const current = thisBoot(db, runtime, corpus, row && row.corpus === id ? row : null, now);

  // Only boots that hashed the same events. A row taken over another corpus is not a disagreement
  // and is not an agreement either; it is a different question, and answering with it is what the
  // moving window did.
  const earlier = db
    .query<Row, [string, string]>(
      "SELECT * FROM release_renders WHERE booted_at<? AND corpus=? ORDER BY booted_at DESC",
    )
    .all(runtime.bootedAt, id);
  const lastDifferent = earlier.find((entry) => entry.hash !== current.hash) ?? null;
  // The run of boots before this one that said the same thing. Its oldest is the claim worth
  // making: no build since then has moved a card, whatever else those builds changed.
  const agreeing = lastDifferent ? earlier.slice(0, earlier.indexOf(lastDifferent)) : earlier;
  return {
    hash: current.hash,
    cards: current.cards,
    windowDays,
    tookMs: current.tookMs,
    previous: lastDifferent ? { bootedAt: lastDifferent.booted_at, hash: lastDifferent.hash } : null,
    changed: lastDifferent
      ? changedCards(db, current.byEvent ?? cardsOf(db, runtime.bootId), lastDifferent.boot_id)
      : null,
    unchangedSince: agreeing.at(-1)?.booted_at ?? (earlier.length === 0 ? null : runtime.bootedAt),
  };
}
