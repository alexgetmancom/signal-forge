import type { Database } from "bun:sqlite";
import { notificationBlock } from "./notification.js";
import type { Event } from "./types.js";

/**
 * Why one event did not become one message for one destination.
 *
 * The reason is the rule that stopped it, so the reasons can be counted; the detail is the same
 * decision in the words a reader would use, so a single row answers the question without a replay.
 */
export const SUPPRESSION_REASONS = [
  "no_reader_facing_change",
  "scheduled_pricing_rotation",
  "oscillating",
  "already_told_by_another_source",
  "waiting_for_the_move_to_settle",
  "returned_to_the_delivered_state",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function suppressionDetail(event: Event, reason: SuppressionReason): string {
  switch (reason) {
    case "no_reader_facing_change":
      return notificationBlock(event) ?? "Nothing a reader would act on";
    case "scheduled_pricing_rotation":
      return "Base rates rotated onto a tier this record already publishes";
    case "oscillating":
      return "The value returned to one it held earlier today";
    case "already_told_by_another_source":
      return "A source in another family already reported this within six hours";
    case "waiting_for_the_move_to_settle":
      return "This destination heard about this subject less than six hours ago";
    case "returned_to_the_delivered_state":
      return "The move ended where this destination last saw it";
  }
}

/** Records the decision while the batch is open, replacing an earlier verdict for the same pair. */
export function recordSuppression(
  db: Database,
  event: Event,
  destinationId: string,
  batchId: number,
  reason: SuppressionReason,
  now: number,
): void {
  db.query(
    `INSERT INTO suppressions(event_id,destination_id,batch_id,reason,detail,recorded_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(event_id,destination_id) DO UPDATE SET
       batch_id=excluded.batch_id,reason=excluded.reason,detail=excluded.detail,recorded_at=excluded.recorded_at`,
  ).run(event.id, destinationId, batchId, reason, suppressionDetail(event, reason), new Date(now).toISOString());
}

/** An event that speaks after all carries no suppression: the record follows the outcome. */
export function clearSuppression(db: Database, eventId: number, destinationId: string): void {
  db.query("DELETE FROM suppressions WHERE event_id=? AND destination_id=?").run(eventId, destinationId);
}
