import type { Database } from "bun:sqlite";
import { boardPlace, intelligenceIndex, isTellableDebut, withoutEffort } from "./boardSignals.js";
import { recordFor } from "./record.js";
import type { Event } from "./types.js";

/**
 * Whether a board debut still follows a launch, or arrives after the launch stopped being news.
 *
 * A board is not a release feed. Arena ranks a model only once it has votes, so a debut lands
 * roughly a day behind the launch it follows and is read as the launch's second half: `gpt-6.1-sol-max`
 * entered the coding board at #3 twenty-three hours after OpenAI first listed `gpt-6.1-sol`, and the
 * card said something nobody had been told yet. The same model entered vision at #10 seventy-one
 * hours after that listing, by which time the channel had had the launch, the pricing and the
 * Artificial Analysis placing; measured on production, that card came back with two votes down.
 *
 * The clock is this service's own first sighting of the model in a catalogue, a gateway, a registry
 * or an arena roster, never an editorial post: `publications` are outcomes of the newsroom and are
 * never evidence for a signal, and the Studio's window holds fifty posts, so a rule reading it
 * would answer differently as the window moved.
 */

/**
 * How long after a model is first sighted here a board placing is still part of its launch.
 *
 * Measured on production over the placings this service has sent. The lag from our first sighting of
 * a model to its first board placing was 19.0, 23.1, 23.1, 23.5, 27.7 and 34.1 hours; the placings
 * that were a second board or a second effort level for a model already announced landed at 70, 71
 * and 123. There is nothing between 34 and 70, so the cut goes in the gap rather than inside the
 * first group: a day was short enough to drop `grok-4.7-xhigh` at #10 after 27.7 hours, which was
 * the first thing anyone here had been told about how good it was.
 */
const DEBUT_FOLLOWS_LAUNCH_MS = 48 * 3_600_000;

/**
 * Streams that carry a model becoming callable, which is the launch a board placing follows.
 *
 * `arena` is the roster rather than a board: a model served in the arena is one anybody can use
 * there, and for several launches it was the first venue to carry it at all.
 */
const LAUNCH_STREAMS = ["api-models", "openrouter", "weights", "arena"] as const;

/**
 * The names a board entry's model could be listed under, longest first.
 *
 * A board names the harness and the effort it ran, not the model: `gpt-6.1-sol-max-code-codex-harness`,
 * `claude-sonnet-5.5-xhigh`, `gemini-4-argon-high`. Nothing here guesses which words are the
 * harness -- `max` is an effort for OpenAI and a product for Alibaba -- so each shorter reading is
 * offered to the catalogues and the first one they actually carry wins. A reading without a digit
 * is a word rather than a model, and `claude-opus` would match every Opus ever shipped.
 */
export function launchNames(name: string): string[] {
  const parts = name
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/, "")
    .split("-")
    .filter(Boolean);
  const readings: string[] = [];
  for (let take = parts.length; take >= 2; take--) {
    const reading = parts.slice(0, take).join("-");
    if (/\d/.test(reading)) readings.push(reading);
  }
  return readings;
}

/** When this service first saw the model behind a board entry become callable, or null. */
export function launchSightedAt(db: Database, name: string): string | null {
  const sighting = db.query<{ at: string | null }, [string, string]>(
    `SELECT MIN(detected_at) AS at FROM events
     WHERE kind='new' AND stream IN (${LAUNCH_STREAMS.map((stream) => `'${stream}'`).join(",")})
       AND (lower(entity_id) LIKE '%' || ? || '%'
            OR lower(COALESCE(json_extract(after_json,'$.name'),'')) LIKE '%' || ? || '%')`,
  );
  for (const reading of launchNames(name)) {
    const at = sighting.get(reading, reading)?.at;
    if (at) return at;
  }
  return null;
}

/**
 * True when a debut arrives long enough after its model's launch that the card is a reminder.
 *
 * Fails open three times over. First place is never late: an arrival at the top of a board people
 * quote is the state of the art changing hands, which is news on its own day rather than the second
 * half of somebody's launch -- `claude-opus-5.5-max` took the coding board thirty-four hours after
 * it was first sighted here and `claude-opus-5.5-high` took the text board five days after, and
 * this clock cannot tell either of those from an echo while a place can. A model this service never
 * sighted anywhere else -- Gemini 4 Argon reached the coding board before any catalogue carried it
 * -- has no clock to be late against. So does a board entry with no name to read.
 */
export function followsAnOldLaunch(db: Database, event: Event): boolean {
  /**
   * Only Arena is on this clock. Arena ranks a model once it has human votes, which is why a placing
   * there trails its launch by about a day and is read as the launch's second half. Artificial
   * Analysis runs benchmarks on its own schedule and the delay is a property of its queue rather
   * than of the news: `Qwen-Audio-3.1-TTS-Plus` was measured twelve days after this service first
   * saw the model and the card it produced is one the channel voted up. An AA arrival also carries a
   * number nobody had -- what the model scores -- where a second Arena board carries a place in a
   * table the reader was already shown.
   */
  if (event.source !== "arena-leaderboards") return false;
  if (!isTellableDebut(event) || boardPlace(event) === 1) return false;
  const name = recordFor(event)?.name;
  if (typeof name !== "string" || !name.trim()) return false;
  const launched = launchSightedAt(db, name);
  if (!launched) return false;
  return Date.parse(event.detected_at) - Date.parse(launched) > DEBUT_FOLLOWS_LAUNCH_MS;
}

/**
 * How far back a board is read for the other efforts of a model arriving on it now.
 *
 * A month: a family whose last reading was longer ago than that is being measured again rather than
 * finished being measured, and the window is what keeps this question off the whole table.
 */
const FAMILY_MEMORY_MS = 30 * 24 * 3_600_000;

/** What a board said about one entry, reduced to the two numbers a card would be chosen on. */
type Standing = { at: string; place: number; index: number; id: number };

/**
 * Whether one of a model's efforts outranks another, for picking which carries the card.
 *
 * The best place it took, then the best number, then the lower id so the answer does not depend on
 * the order a reading was parsed in. A reader wants the model's standing, and the effort level that
 * reached the ranked places is the one that stands.
 */
function outranks(one: Standing, other: Standing): boolean {
  if (one.place !== other.place) return one.place < other.place;
  if (one.index !== other.index) return one.index > other.index;
  return one.id < other.id;
}

/**
 * True when this board has already announced the same model at a different reasoning effort.
 *
 * Artificial Analysis publishes a model once per effort, and the five rows are one launch. Two
 * things follow, and both are asked of the board rather than of the batch in hand:
 *
 * An effort that arrives in the same reading as a better one is held, so `GPT-6.1 Sol` is one card
 * under `(max)` at #10 rather than five. The batch cannot answer this, because the ranked efforts
 * and the unranked ones are paced differently -- a place in the top three is told at once and a row
 * with no place waits for the hourly digest -- so they land in different batches and Claude Sonnet
 * 5.5 was announced twice, once per batch, each collapsing its own half.
 *
 * An effort that straggles in days later is held too, whatever place it took. Artificial Analysis
 * published `Grok 4.7 (Low)` on 2026-10-01, ten days after `Grok 4.7 (xhigh)` at #16 had been a
 * card. A reader told on the twenty-first how good Grok 4.7 is does not need telling on the first
 * that a weaker setting of it scores less, and that is the same complaint a second Arena board
 * earned. Being first is what counts here rather than being best, because by then it has been said.
 *
 * Read from the board's own arrivals and not from `speaks`, which is the verdict recorded when the
 * sibling was read: the verdict for these rows was written by the rules that held them, so asking it
 * would answer that no sibling was ever announced and let every straggler through.
 */
export function anotherEffortLeadsThisDebut(db: Database, event: Event): boolean {
  if (!isTellableDebut(event)) return false;
  const record = recordFor(event);
  const category = record?.category;
  const name = record?.name;
  if (typeof category !== "string" || typeof name !== "string") return false;
  const family = withoutEffort(name);
  if (!family) return false;
  const since = new Date(Date.parse(event.detected_at) - FAMILY_MEMORY_MS).toISOString();
  // Only the keys the answer uses are read back, never a body. The prefix narrows the rows and
  // `withoutEffort` decides, so a longer name that merely starts the same way -- `Grok 4.75` beside
  // `Grok 4.7` -- is not taken for a sibling.
  const siblings = db
    .query<
      { id: number; at: string; name: string | null; rank: number | null; idx: number | null },
      [string, string, string, string, string]
    >(
      `SELECT id, detected_at AS at,
              json_extract(after_json,'$.name') AS name,
              json_extract(after_json,'$.rank') AS rank,
              json_extract(after_json,'$.score.artificial_analysis_intelligence_index') AS idx
       FROM events
       WHERE stream='leaderboards' AND kind='new'
         AND detected_at >= ? AND detected_at <= ?
         AND source=? AND json_extract(after_json,'$.category')=?
         AND lower(COALESCE(json_extract(after_json,'$.name'),'')) LIKE ? || '%' ESCAPE '\\'`,
    )
    .all(since, event.detected_at, event.source, category, family.replace(/[%_\\]/g, "\\$&"));
  const standing = (row: { id: number; at: string; rank: number | null; idx: number | null }): Standing => ({
    at: row.at,
    place: row.rank !== null && Number.isInteger(row.rank) && row.rank >= 1 ? row.rank : Number.POSITIVE_INFINITY,
    index: row.idx ?? Number.NEGATIVE_INFINITY,
    id: row.id,
  });
  const mine = standing({
    id: event.id,
    at: event.detected_at,
    rank: boardPlace(event),
    idx: intelligenceIndex(record),
  });
  return siblings
    .filter((sibling) => sibling.id !== event.id && withoutEffort(sibling.name ?? "") === family)
    .some((sibling) => {
      const theirs = standing(sibling);
      // Earlier is enough on its own: the card has been sent and the place no longer decides.
      return theirs.at < mine.at || (theirs.at === mine.at && outranks(theirs, mine));
    });
}
