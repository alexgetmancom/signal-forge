import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { messageParts, storeCards, storeTextMessages } from "./batchMessages.js";
import { sealBatch } from "./batchParts.js";
import type { Delivering, ReadyBatch } from "./batchPolicy.js";
import { batchReading, speakingEvents, withBorrowedContext } from "./batchPolicy.js";
import { readsCards } from "./digests.js";

/**
 * Every batch that is ready, as the messages it becomes.
 *
 * The shape of this is the dispatch and nothing else: read the batch, ask which events speak to each
 * destination, render what does, store it. Each of those is its own function above, because the
 * question "why did this destination not get a card" is answered in exactly one of them.
 */
export function prepareDeliveries(
  db: Database,
  now = Date.now(),
  vendorRoles: Record<string, string> = {},
  allSignalsRole?: string,
  seal = true,
): void {
  const batches = db
    .query<ReadyBatch, [string]>(
      "SELECT id,digest,source,kind,context_json FROM batches WHERE sealed=0 AND ready_at<=? ORDER BY id",
    )
    .all(new Date(now).toISOString());
  for (const batch of batches) {
    let hasSpeakingEvents = false;
    const reading = batchReading(db, batch, now);
    if (!reading) continue;
    const { events, targets, summaries, storyIds, leads, batchView } = reading;
    for (const target of targets) {
      const destination = JSON.parse(target.destination_json) as Destination;
      const work: Delivering = {
        db,
        batch,
        target,
        destination,
        events,
        summaries,
        storyIds,
        leads,
        batchView,
        vendorRoles,
        allSignalsRole,
        now,
      };
      const speaking = speakingEvents(work);
      if (!speaking.length) {
        db.query(
          "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0",
        ).run(batch.id, target.destination_id);
        continue;
      }
      hasSpeakingEvents = true;
      withBorrowedContext(work, speaking);
      const { items, header, blocks, text } = messageParts(work, speaking);
      if (readsCards(destination)) {
        storeCards(work, speaking, items, header);
        continue;
      }
      storeTextMessages(work, { text, header, blocks, items });
    }
    if (seal || !hasSpeakingEvents) sealBatch(db, batch.id);
  }
}
