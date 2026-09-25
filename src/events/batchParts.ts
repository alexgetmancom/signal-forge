/**
 * Writing one message part of a batch, and closing the batch once every part is written.
 *
 * Shared by the event path and by the batches that are not about an event at all -- promotions,
 * recaps, lifecycle reminders -- which is why this is its own module rather than living in either.
 * Moved out of batching.ts unchanged.
 */
import type { Database } from "bun:sqlite";

export type PendingBatch = { id: number; context_json: string | null };
export type BatchTarget = { destination_id: string; destination_json: string };

/**
 * Writes one message part for a destination, replacing it only while it is still unsent.
 * `refreshDestination` also rewrites the stored destination, which event and reminder cards do and
 * promotions and recaps, carried as first written, do not.
 */
/**
 * Which message carried which event, recorded where it is known exactly rather than inferred later
 * from batch membership, which is wrong as soon as a batch pages.
 *
 * Every report that measures whether this service is useful reads through `delivery_events`:
 * `delivered` in source-verdicts, the reaction tally, the reader vote, judge-gap. A delivery with
 * no link is a card the reports cannot see, and the source that sent it looks like a source that
 * has never reached anybody -- which is how a collector earns a recommendation to be switched off.
 */
export function linkDelivery(
  db: Database,
  batchId: number,
  destinationId: string,
  part: number,
  eventIds: readonly number[],
): void {
  const delivery = db
    .query<{ id: number }, [number, string, number]>(
      "SELECT id FROM deliveries WHERE batch_id=? AND destination_id=? AND part=?",
    )
    .get(batchId, destinationId, part);
  if (!delivery) return;
  // A re-render may move an event to another page or drop it; the links describe this render,
  // so an unsent part forgets what an earlier render put on it.
  db.query(
    "DELETE FROM delivery_events WHERE delivery_id IN (SELECT id FROM deliveries WHERE id=? AND status='pending' AND attempts=0)",
  ).run(delivery.id);
  for (const eventId of eventIds)
    db.query("INSERT OR IGNORE INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(delivery.id, eventId);
}

export function upsertDelivery(
  db: Database,
  batchId: number,
  target: BatchTarget,
  body: string,
  part: number,
  now: number,
  refreshDestination: boolean,
): void {
  const refresh = refreshDestination ? "destination_json=excluded.destination_json," : "";
  db.query(
    `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET ${refresh}body=excluded.body,updated_at=excluded.updated_at
     WHERE deliveries.status='pending' AND deliveries.attempts=0`,
  ).run(batchId, target.destination_id, target.destination_json, body, part, new Date(now).toISOString());
}

export function sealBatch(db: Database, batchId: number): void {
  db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batchId);
}
