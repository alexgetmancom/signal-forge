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
    .query<
      { after_json: string | null; detected_at: string; told_at: string | null },
      [string, string, string, number, number]
    >(
      `SELECT e.after_json,e.detected_at,d.updated_at AS told_at
       FROM events e
       JOIN batch_events be ON be.event_id=e.id
       JOIN deliveries d ON d.batch_id=be.batch_id AND d.destination_id=?
       WHERE e.source=? AND e.entity_id=? AND e.id<? AND be.batch_id<>?
         AND d.status IN ${DELIVERED}
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(destinationId, event.source, event.entity_id, event.id, batchId);
  // A delivered departure is still what this destination last heard: it holds like any other card,
  // and there is no state of the record to compare against, so nothing is rewritten.
  if (previous && !previous.after_json) {
    const toldAt = Date.parse(previous.told_at ?? previous.detected_at);
    return {
      hold: Number.isFinite(toldAt) && now - toldAt < COOLDOWN_MS,
      sinceJson: null,
      sinceAt: null,
    };
  }
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

  // The clock starts when the destination was told, not when the change was seen: a card that
  // waited in a retry queue was read later than its evidence was collected.
  const seenAt = Date.parse(previous.told_at ?? previous.detected_at);
  const hold = Number.isFinite(seenAt) && now - seenAt < COOLDOWN_MS;
  return { hold, sinceJson: previous.after_json, sinceAt: previous.detected_at };
}

/** Renders the whole move a destination missed, without rewriting the event it came from. */
export function withBaseline(event: Event, baseline: DeliveryBaseline): Event {
  return baseline.sinceJson ? { ...event, before_json: baseline.sinceJson } : event;
}

/**
 * A move that was held and then stopped moving.
 *
 * A hold only ever spoke again when the next step arrived, so the last step of every slide was the
 * one nobody heard: $15 → $13 (told) → $11.70 (held) and then nothing, forever. Once the cooldown
 * has passed and no newer step exists for the subject, the held event is put back into a digest of
 * its own for that destination, where it is judged again -- against the state the destination last
 * saw, so the card covers the whole move -- and either speaks or leaves a new written reason.
 */
export function releaseSettledMoves(db: Database, now = Date.now()): number {
  const held = db
    .query<
      Event & { destination_id: string; held_batch: number; url: string; signal: string; destination_json: string },
      []
    >(
      `SELECT e.*,s.destination_id,s.batch_id AS held_batch,be.url,be.signal,bt.destination_json
       FROM suppressions s
       JOIN events e ON e.id=s.event_id
       JOIN batch_events be ON be.batch_id=s.batch_id AND be.event_id=s.event_id
       JOIN batch_targets bt ON bt.batch_id=s.batch_id AND bt.destination_id=s.destination_id
       WHERE s.reason='waiting_for_the_move_to_settle'
         AND NOT EXISTS (SELECT 1 FROM events later WHERE later.source=e.source AND later.entity_id=e.entity_id AND later.id>e.id)
       ORDER BY e.id`,
    )
    .all();
  let released = 0;
  for (const row of held) {
    if (deliveryBaseline(db, row, row.destination_id, row.held_batch, now).hold) continue;
    const batch = db
      .query<{ id: number }, [string]>(
        "INSERT INTO batches(source,digest,ready_at) VALUES('story-digest',1,?) RETURNING id",
      )
      .get(new Date(now).toISOString());
    if (!batch) throw new Error("Batch insert failed");
    db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,?)").run(
      batch.id,
      row.id,
      row.url,
      row.signal,
    );
    db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
      batch.id,
      row.destination_id,
      row.destination_json,
    );
    // Released once: the new batch writes its own reason if it stays quiet.
    db.query("DELETE FROM suppressions WHERE event_id=? AND destination_id=?").run(row.id, row.destination_id);
    released++;
  }
  return released;
}
