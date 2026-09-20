import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { readState, writeState } from "../storage/appState.js";
import { sourceIndependenceFamily } from "./sourceFamily.js";
import type { Confidence, Event, SourceAuthority } from "./types.js";

/**
 * A model three unrelated sources have recorded and no reader has heard of.
 *
 * Every rule that decides whether an event speaks is a veto: `standingReason` runs a list of
 * reasons to stay quiet and the first that applies wins. That is the right shape for one event,
 * and it has no shape at all for a subject. A leaderboard debut outside the top ten is a row, a
 * gateway listing of an unfollowed maker is a line in the scouts' morning, and a mirror repeating
 * that listing is nothing -- each verdict correct on its own, and nothing anywhere adds them up.
 *
 * StepFun's Step 5 Preview collected all three on 2026-09-19 and 2026-09-20: Artificial Analysis
 * scored it 43.6, the Vercel gateway listed it with a price, models.dev copied the listing. Three
 * unrelated organisations spent a day describing a model with a million-token context, and the
 * deployment said "moves too small for a card of their own". `stories` had already counted it
 * correctly -- `independentSourceCount: 3`, `corroborated: true` -- and nothing read the count.
 *
 * This reads it. A story that reaches the threshold while no card about it has ever been delivered
 * is sent to the rooms that carry sightings, once, with the count as its headline. It overrules no
 * individual verdict: each of those events was still not worth a card by itself, and the card this
 * sends is about the accumulation, which is a different claim.
 *
 * `breakoutOf` answers the neighbouring question -- a small maker's model taking off -- and counts
 * only catalogues, repositories and front pages for arrivals at a reseller. It would not have seen
 * Step 5 on any of the three: the leaderboard is not a catalogue, models.dev is a mirror it
 * discounts by design, and the first event was never a candidate because its stream was not one a
 * reseller writes to.
 */
const SEEN_PREFIX = "corroborated:story:";
/**
 * The same verdict keyed by the event the card was rendered from, because the renderer is handed an
 * event and has no story in its hands. Two keys for one decision, written in one transaction.
 */
const CARD_PREFIX = "corroborated:event:";

/**
 * Three unrelated organisations, not two.
 *
 * Two is the threshold `stories` already calls corroboration, and on the week to 2026-09-20 it
 * would have carried Mixedbread's Toast 1 and Quiver's Arrow 2 as well -- both of which the daily
 * recap was right to call too small. Three is what Step 5 Preview had. The number is here rather
 * than in the config because it is a claim about how much agreement is worth interrupting a reader
 * for, and an operator changing it silently would change what the channel means.
 */
export const INDEPENDENT_SOURCES = 3;

/**
 * How recently the story must still be moving. A subject whose last word was a week ago is not news
 * because a third source finally repeated it; the card would be an archive entry.
 */
const WATCH_MS = 72 * 3_600_000;

type CorroboratedRow = {
  story_id: number;
  stable_key: string;
  title: string;
  vendor: string | null;
};

export type Corroboration = { title: string; families: string[]; eventIds: number[]; at: string };

export function corroborationOf(db: Database, storyId: number): Corroboration | null {
  const stored = readState(db, `${SEEN_PREFIX}${storyId}`);
  return stored ? (JSON.parse(stored) as Corroboration) : null;
}

/** The verdict behind one card, for the renderer that only ever holds the event. */
export function corroborationOfEvent(db: Database, eventId: number): Corroboration | null {
  const stored = readState(db, `${CARD_PREFIX}${eventId}`);
  return stored ? (JSON.parse(stored) as Corroboration) : null;
}

type StoryEvidence = Event & {
  confidence: Confidence;
  authority: SourceAuthority;
  vendor: string | null;
  story_id: number;
  stable_key: string;
  title: string;
  story_vendor: string | null;
  delivered: number;
};

/**
 * Every event of every story that has moved inside the window, with the two facts the count needs:
 * whose voice the source is, and whether any of it ever reached a reader.
 *
 * The vendor is the registry's vendor for the source, never the vendor of the model reported --
 * `sourceIndependenceFamily` is explicit that a host listing another maker's model is the host
 * speaking, and joining `sources` rather than `stories` is what keeps that true here.
 */
function evidenceInWindow(db: Database, since: string): StoryEvidence[] {
  return db
    .query<StoryEvidence, [string]>(
      `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.before_json,e.after_json,e.detected_at,
              e.confidence,e.authority,src.vendor,
              s.id AS story_id,s.stable_key,s.title,s.vendor AS story_vendor,
              EXISTS(SELECT 1 FROM batch_events be JOIN deliveries d ON d.batch_id=be.batch_id
                     WHERE be.event_id=e.id) AS delivered
       FROM stories s
       JOIN story_events se ON se.story_id=s.id
       JOIN events e ON e.id=se.event_id
       LEFT JOIN sources src ON src.id=e.source
       WHERE s.updated_at>=?
       ORDER BY s.id,e.detected_at,e.id`,
    )
    .all(since);
}

/**
 * Stories that have reached the threshold and never spoken, newest first.
 *
 * A story any of whose events reached a reader is not silent: the reader has the model, and a
 * second card counting the sources that agree about it is a card about our own bookkeeping.
 */
function silentAndCorroborated(db: Database, now: number): { row: CorroboratedRow; evidence: StoryEvidence[] }[] {
  const grouped = new Map<number, StoryEvidence[]>();
  for (const event of evidenceInWindow(db, new Date(now - WATCH_MS).toISOString()))
    grouped.set(event.story_id, [...(grouped.get(event.story_id) ?? []), event]);
  const ready: { row: CorroboratedRow; evidence: StoryEvidence[] }[] = [];
  for (const [storyId, evidence] of grouped) {
    if (evidence.some((event) => event.delivered)) continue;
    const families = new Set(evidence.map((event) => sourceIndependenceFamily(event)));
    if (families.size < INDEPENDENT_SOURCES) continue;
    const first = evidence[0];
    if (!first) continue;
    ready.push({
      row: { story_id: storyId, stable_key: first.stable_key, title: first.title, vendor: first.story_vendor },
      evidence,
    });
  }
  return ready;
}

/**
 * The event the card is rendered from: the last one, because it is the one that completed the
 * count, and because a catalogue listing carries a price and a context window where a leaderboard
 * row carries a rank nobody asked for.
 */
function cardEvent(evidence: StoryEvidence[]): StoryEvidence | null {
  return evidence.at(-1) ?? null;
}

/**
 * Send one card for every story that has crossed the threshold in silence, and remember it so the
 * next pass leaves it alone. Returns the story ids that spoke, which the worker logs.
 */
export function detectCorroborated(db: Database, destinations: readonly Destination[], now = Date.now()): number[] {
  const targets = destinations.filter((destination) => destination.signals.includes("codename"));
  const spoke: number[] = [];
  for (const { row, evidence } of silentAndCorroborated(db, now)) {
    if (corroborationOf(db, row.story_id)) continue;
    const event = cardEvent(evidence);
    if (!event) continue;
    const corroboration: Corroboration = {
      title: row.title,
      families: [...new Set(evidence.map((entry) => sourceIndependenceFamily(entry)))].sort(),
      eventIds: evidence.map((entry) => entry.id),
      at: new Date(now).toISOString(),
    };
    db.transaction(() => {
      writeState(db, `${SEEN_PREFIX}${row.story_id}`, JSON.stringify(corroboration));
      writeState(db, `${CARD_PREFIX}${event.id}`, JSON.stringify(corroboration));
      if (!targets.length) return;
      const batch = db
        .query<{ id: number }, [string, string]>(
          "INSERT INTO batches(source,digest,ready_at) VALUES(?,0,?) RETURNING id",
        )
        .get(event.source, corroboration.at);
      if (!batch) throw new Error("Corroboration batch insert failed");
      const record = JSON.parse(event.after_json ?? "{}") as { url?: unknown };
      db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,'codename')").run(
        batch.id,
        event.id,
        typeof record.url === "string" ? record.url : "",
      );
      for (const destination of targets)
        db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
          batch.id,
          destination.id,
          JSON.stringify(destination),
        );
    })();
    spoke.push(row.story_id);
  }
  return spoke;
}

/** The line above the card, in the agreement that earned it: "🔭 Step 5 Preview · 3 sources agree". */
export function corroborationLine(corroboration: Corroboration): string {
  return `🔭 ${corroboration.title} · recorded by ${corroboration.families.length} unrelated sources, never carded`;
}
