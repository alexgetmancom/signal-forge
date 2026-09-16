import type { Database } from "bun:sqlite";
import { canonical } from "./canonical.js";
import type { Event, RecordData } from "./types.js";

/**
 * A value that returns to where it was is not news. Both guards below keep the event and its
 * evidence untouched; they only decide that a subscriber does not need a message about it.
 */

/** How long a board entry that keeps arriving and leaving stays the same piece of news. */
const REAPPEARANCE_WINDOW_MS = 14 * 24 * 3_600_000;

/** How far back a repeated value still counts as the same oscillation. */
const OSCILLATION_WINDOW_MS = 48 * 3_600_000;
/** A field must have moved this often inside the window before a repeat reads as dithering. */
const MIN_PRIOR_CHANGES = 2;
/** Fields whose level can legitimately move back and forth without the subject changing. */
const OSCILLATING_FIELDS = new Set(["pricing", "context", "rank", "score", "votes"]);

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
}

function priceTiers(pricing: unknown): Record<string, unknown>[] {
  if (!pricing || typeof pricing !== "object") return [];
  const overrides = (pricing as Record<string, unknown>).overrides;
  return Array.isArray(overrides) ? overrides.filter((tier): tier is Record<string, unknown> => !!tier) : [];
}

function baseRates(pricing: unknown, tier: Record<string, unknown>): boolean {
  if (!pricing || typeof pricing !== "object") return false;
  const base = pricing as Record<string, unknown>;
  const rates = Object.keys(tier).filter((key) => !key.startsWith("utc_") && key !== "min_prompt_tokens");
  return (
    rates.length > 0 && rates.every((key) => base[key] !== undefined && canonical(base[key]) === canonical(tier[key]))
  );
}

/**
 * Some catalogues publish a base price alongside the time-of-day tiers it rotates through. When
 * the new base rates equal one of the record's own published tiers, the source is following its
 * own schedule and nothing was repriced.
 */
export function isScheduledPricingRotation(event: Event): boolean {
  if (event.kind !== "changed") return false;
  const before = parse(event.before_json);
  const after = parse(event.after_json);
  if (!before || !after) return false;
  const changed = changedFields(before, after);
  if (changed.length !== 1 || changed[0] !== "pricing") return false;
  const tiers = priceTiers(after.pricing);
  if (tiers.length < 2) return false;
  return tiers.some((tier) => baseRates(after.pricing, tier)) && tiers.some((tier) => baseRates(before.pricing, tier));
}

/**
 * A level that comes back to a value already observed in the window, after having moved at least
 * twice, is dithering rather than moving. Only fields whose level can swing are considered, and
 * every changed field must be dithering before the event stays silent.
 */
export function isOscillating(db: Database, event: Event, now = Date.now()): boolean {
  if (event.kind !== "changed") return false;
  const before = parse(event.before_json);
  const after = parse(event.after_json);
  if (!before || !after) return false;
  const changed = changedFields(before, after);
  if (!changed.length || !changed.every((field) => OSCILLATING_FIELDS.has(field))) return false;

  const since = new Date(now - OSCILLATION_WINDOW_MS).toISOString();
  const history = db
    .query<{ before_json: string | null; after_json: string | null }, [string, string, number, string]>(
      `SELECT before_json,after_json FROM events
       WHERE source=? AND entity_id=? AND id<? AND kind='changed' AND detected_at>=?
       ORDER BY id`,
    )
    .all(event.source, event.entity_id, event.id, since);
  if (!history.length) return false;

  return changed.every((field) => {
    const moves = history
      .map((row) => ({ from: parse(row.before_json)?.[field], to: parse(row.after_json)?.[field] }))
      .filter((move) => canonical(move.from) !== canonical(move.to));
    if (moves.length < MIN_PRIOR_CHANGES) return false;
    const seen = new Set(moves.flatMap((move) => [canonical(move.from), canonical(move.to)]));
    return seen.has(canonical((after as RecordData)[field]));
  });
}

/** The streams where a row arriving twice is the source flickering rather than a second arrival. */
const FLICKERING_STREAMS = ["leaderboards", "arena", "openrouter", "api-models", "weights"];

/**
 * Fields whose value is the reason a reader would want to hear about the row a second time. A
 * catalogue that drops a model and lists it again an hour later has said nothing new; one that
 * lists it again at half the price, a quarter of the context or a different set of providers has.
 */
const SUBSTANTIVE_FIELDS = ["pricing", "context", "input", "output", "providers", "parameters", "selectable"];

/**
 * A row that comes and goes.
 *
 * `muse-spark-1.3-max` arrived on a design board, left the next day and arrived again the day
 * after, and each arrival was announced as a new sighting. The first one is the news; an entry
 * that is being switched on and off says nothing more about the model behind it.
 *
 * Catalogues do the same thing and were not covered: `z-ai/glm-5.2:free` was listed on OpenRouter
 * at 09:21 on 2026-09-15, gone by 09:31 and back at 12:59, and both arrivals were delivered to the
 * public channel as launches of the same model. The rename window is three hours and this gap was
 * three hours thirty-eight, so nothing else caught it either.
 */
export function isReappearance(db: Database, event: Event, now = Date.now()): boolean {
  if (event.kind !== "new" || !FLICKERING_STREAMS.includes(event.stream)) return false;
  const since = new Date(now - REAPPEARANCE_WINDOW_MS).toISOString();
  // A row's first appearance leaves no event at all: the collection that establishes the baseline
  // is silent by design. So the thing that marks a return is the departure, not an earlier
  // arrival, and a row that has only ever been added is caught by the earlier arrival instead.
  const earlier = db
    .query<{ after_json: string | null; before_json: string | null; kind: string }, [string, string, number, string]>(
      `SELECT after_json,before_json,kind FROM events
       WHERE source=? AND entity_id=? AND id<? AND detected_at>=? AND kind IN ('new','removed') ORDER BY id DESC`,
    )
    .all(event.source, event.entity_id, event.id, since);
  if (!earlier.length) return false;
  // A row that comes back changed is a change, and saying so once is the point of the class. Only
  // the fields a reader acts on count: a catalogue reorders its own metadata between polls.
  const after = parse(event.after_json);
  const previous = earlier[0];
  // A departure carries the row it removed in `before_json`; an arrival carries it in `after_json`.
  const last = parse((previous?.kind === "removed" ? previous.before_json : previous?.after_json) ?? null);
  if (after && last) return !SUBSTANTIVE_FIELDS.some((field) => canonical(last[field]) !== canonical(after[field]));
  return true;
}
