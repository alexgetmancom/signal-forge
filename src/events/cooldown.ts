import type { Database } from "bun:sqlite";
import type { Event } from "./types.js";

/**
 * A price that slides gives a reader the same news six times.
 *
 * Kimi K3 went $15 → $13 → $11.70 → $10.53 → $9.48 in twelve hours, and every step was a real
 * change of its own: no repeat, no return to a value it already held, so neither the price
 * thresholds nor the oscillation guard had anything to object to. Six messages said what one
 * message says better, and the one message is the one a person can act on: down 37% since morning.
 *
 * So a moving number waits. While it waits nothing is sent, and when it speaks again it is
 * compared against the last state this destination actually saw rather than against the step
 * before it. Stored evidence keeps every step; only the card is drawn differently.
 */
const COOLDOWN_MS = 6 * 3_600_000;

/**
 * A price can also slide the other way: in steps too small to report, for as long as it likes.
 * $1.896 → $1.720 → $1.630 → $1.560 is 9.3%, 5.2% and 4.3%, every step honestly below the ten
 * percent that makes a price worth reporting — and a total of 17.7% that the reader never hears
 * about, then or later, because each step is only ever compared against the step before it.
 *
 * So when a destination has heard nothing about a subject yet, the comparison still has a starting
 * point: the earliest state on record inside this window. Small moves accumulate against it until
 * together they cross the threshold, and then one card covers the whole drift.
 */
const DRIFT_WINDOW_MS = 7 * 24 * 3_600_000;

const DELIVERED = "('pending','sending','sent','ambiguous','verification_required')";

export type DeliveryBaseline = {
  /** The change is real, but this destination heard about this subject too recently. */
  hold: boolean;
  /** The state this destination last saw, to compare against instead of the previous step. */
  sinceJson: string | null;
  /** When that state was delivered, for a card that says what period it covers. */
  sinceAt: string | null;
};

/**
 * What a destination already knows about one subject. Only events that produced delivery work for
 * that destination count: a card nobody was sent is not a card anyone read.
 */
export function deliveryBaseline(
  db: Database,
  event: Event,
  destinationId: string,
  batchId: number,
  now = Date.now(),
): DeliveryBaseline {
  const previous = db
    .query<{ after_json: string | null; detected_at: string }, [string, string, string, number, number]>(
      `SELECT e.after_json,e.detected_at
       FROM events e
       JOIN batch_events be ON be.event_id=e.id
       JOIN deliveries d ON d.batch_id=be.batch_id AND d.destination_id=?
       WHERE e.source=? AND e.entity_id=? AND e.id<? AND be.batch_id<>?
         AND d.status IN ${DELIVERED}
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(destinationId, event.source, event.entity_id, event.id, batchId);
  if (!previous?.after_json) {
    const earliest = db
      .query<{ before_json: string | null; detected_at: string }, [string, string, number, string]>(
        `SELECT e.before_json,e.detected_at FROM events e
         WHERE e.source=? AND e.entity_id=? AND e.id<? AND e.detected_at>=?
         ORDER BY e.id ASC LIMIT 1`,
      )
      .get(event.source, event.entity_id, event.id, new Date(now - DRIFT_WINDOW_MS).toISOString());
    return earliest?.before_json
      ? { hold: false, sinceJson: earliest.before_json, sinceAt: earliest.detected_at }
      : { hold: false, sinceJson: null, sinceAt: null };
  }

  const seenAt = Date.parse(previous.detected_at);
  const hold = Number.isFinite(seenAt) && now - seenAt < COOLDOWN_MS;
  return { hold, sinceJson: previous.after_json, sinceAt: previous.detected_at };
}

/** Renders the whole move a destination missed, without rewriting the event it came from. */
export function withBaseline(event: Event, baseline: DeliveryBaseline): Event {
  return baseline.sinceJson ? { ...event, before_json: baseline.sinceJson } : event;
}
