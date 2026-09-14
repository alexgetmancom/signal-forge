import type { Database } from "bun:sqlite";
import { canonical } from "./canonical.js";
import { normalizeIdentity } from "./identity.js";
import type { Event, RecordData } from "./types.js";

/**
 * Observations that are true, cheap to make, and not worth a message.
 *
 * Each of these was read in the invited room on 14 September and could not be explained to the
 * person who owns the channel: a model entering a benchmark in fifth place, the same Kimi K3 served
 * through a gateway as though it were a stranger, and a catalogue row whose only change was that
 * the vendor's name had been prefixed to its own title.
 */

/** A place on a board a reader would repeat to somebody else. */
const TOP_PLACES = 3;

function record(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

/**
 * A board entry that is not near the top.
 *
 * Entering a benchmark at rank 2 is a fact about the frontier; entering it at rank 5, or sliding
 * from 6 to 7, is a fact about a table. Taking first place is always news, whichever way it moved.
 */
export function isMinorBoardMove(event: Event): boolean {
  if (event.stream !== "leaderboards") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const place = Number(after?.rank ?? Number.NaN);
  if (event.kind === "new") return !(Number.isFinite(place) && place <= TOP_PLACES);
  if (event.kind === "removed") return Number(before?.rank ?? Number.NaN) > TOP_PLACES;
  // A change speaks when it puts something first, or takes something off the top.
  const was = Number(before?.rank ?? Number.NaN);
  return !(place === 1 || (was === 1 && place !== 1));
}

/**
 * The ways one model is served, as opposed to which model it is.
 *
 * `kimi-k3-gateway-max-v3` is Kimi K3 reached through a gateway at maximum thinking effort with the
 * third harness. An arena lists each wiring separately and each one arrived as an unidentified
 * sighting. These words can never distinguish two models, so a name that is a model we already know
 * plus only these is that model.
 */
const SERVING_WORDS = new Set([
  "gateway",
  "official",
  "api",
  "direct",
  "proxy",
  "harness",
  "endpoint",
  "chat",
  "thinking",
  "reasoning",
  "max",
  "high",
  "medium",
  "low",
  "effort",
]);

function servingTail(words: string[]): boolean {
  return words.length > 0 && words.every((word) => SERVING_WORDS.has(word) || /^v?\d+$/.test(word));
}

/** Models something in this database already identifies, as normalized word lists. */
export function knownModelNames(db: Database): string[][] {
  const names = new Set<string>();
  for (const row of db
    .query<{ body: string }, []>(
      "SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights','deprecations')",
    )
    .all()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const value of [parsed.name, parsed.id])
      if (typeof value === "string" && value.trim()) {
        // A catalogue writes "DeepSeek: DeepSeek V4 Flash"; the maker's prefix is not part of the
        // model's name, and an arena never repeats it.
        const stripped = value.replace(/^[^:/]+[:/]\s*/, "");
        names.add(normalizeIdentity(stripped));
      }
  }
  return [...names].filter((name) => name.split(" ").length >= 2).map((name) => name.split(" "));
}

/** True when this arena entry is a known model with only its wiring appended. */
export function isAnotherServing(event: Event, known: readonly string[][]): boolean {
  if (event.stream !== "arena" || event.kind !== "new") return false;
  const words = normalizeIdentity(String(record(event)?.name ?? event.entity_id))
    .split(" ")
    .filter(Boolean);
  return known.some(
    (model) =>
      words.length > model.length &&
      model.every((word, index) => words[index] === word) &&
      servingTail(words.slice(model.length)),
  );
}

/** Fields that say how a record is addressed and displayed, not what it is. */
const LABELS = new Set(["name", "model", "modelKey", "slug", "title"]);

/**
 * A change that is only a change of label.
 *
 * OpenRouter prefixed its own catalogue titles with the vendor, and "DeepSeek V4 Flash Latest"
 * became "DeepSeek: DeepSeek V4 Flash Latest" -- a card, in a channel, about a display string. An
 * arena is the exception: a codename acquiring a real name is the entire point of watching one.
 */
export function isLabelOnlyChange(event: Event): boolean {
  if (event.kind !== "changed" || event.stream === "arena" || event.stream === "leaderboards") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
  if (!before || !after) return false;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
  return changed.length > 0 && changed.every((key) => LABELS.has(key));
}

/**
 * A row that exists to point at whatever is newest.
 *
 * `~deepseek/deepseek-v4-flash-latest` is not a model: it is a promise to route to one. Its every
 * move duplicates a card the model behind it already produced.
 */
export function isAliasRow(event: Event): boolean {
  const name = String(record(event)?.name ?? event.entity_id);
  return /[:\s/-]latest$/i.test(name.trim()) || event.entity_id.startsWith("~");
}
