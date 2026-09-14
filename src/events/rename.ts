import type { Database } from "bun:sqlite";
import type { Event } from "./types.js";

/**
 * The same record under a new key.
 *
 * A catalogue re-keys its rows and every collector reads it as a wave: DeepSeek's pricing table
 * renamed its entries on 10 September, and `deepseek-v4-pro` left while an identical row arrived
 * under a numbered key half an hour later. Both halves are true observations and neither is news --
 * the model was there before and is there now, called something else.
 *
 * What makes it decidable is the body: everything except the key is byte for byte the same. When it
 * is not -- `deepseek-flash` carried a different version and different prices from the row it
 * replaced -- that is a real release wearing a reused name, and it is left alone. The comparison is
 * evidence, not a guess, which is why this can quiet a card at all.
 */
const RENAME_WINDOW_MS = 3 * 3_600_000;
/** How a record is addressed, as opposed to what it says. */
const KEYS = new Set(["id", "name", "model", "modelKey", "url", "canonical_id", "canonicalId", "slug"]);
/** A re-keying touches a handful of rows; a source that produces more than this is doing something else. */
const CANDIDATES = 200;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function body(json: string | null): string | null {
  if (!json) return null;
  try {
    return JSON.stringify(stable(JSON.parse(json)));
  } catch {
    return null;
  }
}

/** The event that is the other half of a rename, or null when this stands on its own. */
export function renamedCounterpart(db: Database, event: Event): Event | null {
  if (event.kind === "changed") return null;
  const mine = body(event.kind === "new" ? event.after_json : event.before_json);
  if (!mine || mine === "{}") return null;
  const at = Date.parse(event.detected_at);
  const candidates = db
    .query<Event, [string, string, string, string, number]>(
      `SELECT * FROM events WHERE source=? AND kind=? AND detected_at>=? AND detected_at<=? AND id!=?
       ORDER BY detected_at LIMIT ${CANDIDATES}`,
    )
    .all(
      event.source,
      event.kind === "new" ? "removed" : "new",
      new Date(at - RENAME_WINDOW_MS).toISOString(),
      new Date(at + RENAME_WINDOW_MS).toISOString(),
      event.id,
    );
  return (
    candidates.find(
      (candidate) => body(candidate.kind === "new" ? candidate.after_json : candidate.before_json) === mine,
    ) ?? null
  );
}

/** The events in this set that are one half of a rename, found in one pass. */
export function renamedEvents(db: Database, events: readonly Event[]): Set<number> {
  const renamed = new Set<number>();
  for (const event of events) if (renamedCounterpart(db, event)) renamed.add(event.id);
  return renamed;
}
