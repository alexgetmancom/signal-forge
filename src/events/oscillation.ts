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

/**
 * A codename that comes and goes.
 *
 * `muse-spark-1.3-max` arrived on a design board, left the next day and arrived again the day
 * after, and each arrival was announced as a new sighting. The first one is the news; a board
 * entry that is being switched on and off says nothing more about the model behind it.
 */
export function isReappearance(db: Database, event: Event, now = Date.now()): boolean {
  if (event.kind !== "new" || !["leaderboards", "arena"].includes(event.stream)) return false;
  const since = new Date(now - REAPPEARANCE_WINDOW_MS).toISOString();
  const seen = db
    .query<{ c: number }, [string, string, number, string]>(
      "SELECT COUNT(*) c FROM events WHERE source=? AND entity_id=? AND id<? AND detected_at>=? AND kind='new'",
    )
    .get(event.source, event.entity_id, event.id, since);
  return (seen?.c ?? 0) > 0;
}
