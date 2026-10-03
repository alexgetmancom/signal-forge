import type { Database } from "bun:sqlite";
import { boardPlace, isTellableDebut } from "./boardSignals.js";
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

/** How long after a model is first sighted here a board placing is still part of its launch. */
const DEBUT_FOLLOWS_LAUNCH_MS = 24 * 3_600_000;

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
  if (!isTellableDebut(event) || boardPlace(event) === 1) return false;
  const name = recordFor(event)?.name;
  if (typeof name !== "string" || !name.trim()) return false;
  const launched = launchSightedAt(db, name);
  if (!launched) return false;
  return Date.parse(event.detected_at) - Date.parse(launched) > DEBUT_FOLLOWS_LAUNCH_MS;
}
