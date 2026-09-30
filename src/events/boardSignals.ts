/**
 * Scoreboards: which of them a reader quotes, what place an arrival took, and when a place is news.
 *
 * A row moving is a number moving. Only a debut near the top of a board people quote says anything
 * about a model, and only Artificial Analysis lists a model it has not already measured.
 */
import { recordFor } from "./record.js";
import type { Event, RecordData } from "./types.js";

/**
 * A place on a scoreboard people quote. A top-ten debut here is what a reader repeats about a new
 * model; the design and niche boards are sightings for the scouts when they are anything at all.
 */
const MAIN_BOARDS = new Set([
  "text/overall",
  "code/overall",
  "vision/overall",
  "text-to-image/overall",
  "image-edit/overall",
  "text-to-video/overall",
  "image-to-video/overall",
  "artificial-analysis/quality",
  "artificial-analysis/text-to-image",
  "artificial-analysis/image-editing",
  "artificial-analysis/text-to-speech",
  "artificial-analysis/text-to-video",
]);
/** Only the top ten is news; below it a new name is a row. */
export const DEBUT_PLACES = 10;

/**
 * A model Artificial Analysis has measured, arriving outside the places it ranks.
 *
 * The site ranks only its leading twenty, so a model below them has no place at all and every
 * arrival there was a `rank` -- the class the daily recap empties, 3250 events in the week to
 * 2026-09-20 against 34 delivered. That is right for the boards where a new row is a row, and wrong
 * here: this site does not list a model until it has run the benchmarks, so an arrival carries a
 * measured Intelligence Index and is a claim about the model rather than about the board. Step 5
 * Preview arrived at 43.6, was named in the recap as one line among six, and waited a day for a
 * gateway and a mirror to agree before anything else happened.
 *
 * It is a sighting for the scouts, not the public wire. The number says a real model exists and
 * performs; it does not say anyone can call it, and on this board a preview sits beside shipped
 * models with no way to tell them apart. The top ten still goes out as a `debut`.
 *
 * There is deliberately no floor on the index. One would have to be a number on a scale that moves
 * as the benchmarks are rewritten, and the board's own cutoff is not in hand here. The cost of that
 * is a card for a weak arrival, which is why `passed-over` and the next `channel-mix` reading are
 * scheduled against this rule rather than a guess being tuned now.
 */
/**
 * The number this site is quoted for, off a record it measured. Its `score` is the whole sheet of
 * evaluations rather than one rating, so a card that looked for a number found an object.
 */
export function intelligenceIndex(record: RecordData | null | undefined): number | null {
  const score = record?.score;
  if (typeof score !== "object" || score === null) return null;
  const index = (score as Record<string, unknown>).artificial_analysis_intelligence_index;
  return typeof index === "number" && Number.isFinite(index) ? index : null;
}

export function scoredDebutIndex(event: Event): number | null {
  if (event.source !== "artificial-analysis" || event.stream !== "leaderboards" || event.kind !== "new") return null;
  const place = boardPlace(event);
  if (place !== null && place <= DEBUT_PLACES) return null;
  const record = recordFor(event);
  return isMainBoard(record?.category) ? intelligenceIndex(record) : null;
}

/**
 * Which board's picture a reader wants when one arrival lands on more than one of them.
 *
 * Every board here is worth a card on its own, so this is not about worth: it is about which single
 * number goes on the picture when a model debuts twice in one reading. Code first, because what
 * these readers do with a model is write code with it, and a place on the coding board is the one
 * they act on; the general text board is the headline number and sits behind it. Anything unlisted
 * falls to the place it took, which is how a board with no opinion attached is still ordered.
 */
const BOARDS_BY_INTEREST = ["code/overall", "text/overall", "vision/overall", "artificial-analysis/quality"];
export function boardInterest(event: Event): number {
  const category = recordFor(event)?.category;
  const at = typeof category === "string" ? BOARDS_BY_INTEREST.indexOf(category) : -1;
  return at === -1 ? BOARDS_BY_INTEREST.length : at;
}

/**
 * A debut a reader repeats: a new row in the leading places of a board people quote.
 *
 * The threshold lived twice. `DEBUT_PLACES` called the top ten a debut and gave the class its name,
 * while both delivery gates asked `TOP_PLACES` -- three -- of a new row, so every debut from fourth
 * to tenth was classed, rendered, and then silenced as "Leaderboard movement outside the top 3".
 * Gemini 4 Argon arrived at #8 on Arena Code and at #8 on Artificial Analysis on 2026-09-30 and
 * neither reached a channel; from outside that is indistinguishable from the collector not running.
 * A debut is a subject arriving, which is why it is told wider than a row moving inside the table.
 */
export function isTellableDebut(event: Event): boolean {
  if (event.stream !== "leaderboards" || event.kind !== "new") return false;
  const place = boardPlace(event);
  return place !== null && place <= DEBUT_PLACES && isMainBoard(recordFor(event)?.category);
}

/** The place a new board entry took, when it is a real one: a board once served a model at #0. */
export function boardPlace(event: Event): number | null {
  const rank = recordFor(event)?.rank;
  return typeof rank === "number" && Number.isInteger(rank) && rank >= 1 ? rank : null;
}

export function isMainBoard(category: unknown): boolean {
  return typeof category === "string" && MAIN_BOARDS.has(category);
}
