import type { Database } from "bun:sqlite";
import { notificationBlock } from "./notification.js";
import type { Event } from "./types.js";

/**
 * Why one event did not become one message for one destination.
 *
 * The reason is the rule that stopped it, so the reasons can be counted; the detail is the same
 * decision in the words a reader would use, so a single row answers the question without a replay.
 */
const SUPPRESSION_REASONS = [
  "no_reader_facing_change",
  "scheduled_pricing_rotation",
  "oscillating",
  "flapping_in_and_out",
  "already_told_by_another_source",
  "waiting_for_the_move_to_settle",
  "returned_to_the_delivered_state",
  "renamed_by_the_source",
  "below_the_top_of_the_board",
  "another_serving_of_a_known_model",
  "display_label_only",
  "alias_of_another_row",
  "a_post_about_the_company_not_a_model",
  "another_tier_of_a_listed_model",
  "published_by_a_followed_lab",
  "weights_with_nothing_to_run",
  "weights_published_long_ago",
  "another_page_about_the_same_model",
  "past_the_digest_limit",
  "left_to_the_daily_recap",
  "already_out_at_its_maker",
  "names_only_known_models",
  "fixes_only_release",
  "a_reseller_filled_in_a_price",
  "a_page_about_no_product",
  "trending_from_an_unfollowed_lab",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

function suppressionDetail(event: Event, reason: SuppressionReason): string {
  switch (reason) {
    case "no_reader_facing_change":
      return notificationBlock(event) ?? "Nothing a reader would act on";
    case "scheduled_pricing_rotation":
      return "Base rates rotated onto a tier this record already publishes";
    case "oscillating":
      return "The value returned to one it held earlier today";
    case "flapping_in_and_out":
      return "This entry has arrived on the board before and was announced then";
    case "already_told_by_another_source":
      return "A source in another family already reported this within six hours";
    case "waiting_for_the_move_to_settle":
      return "This destination heard about this subject less than six hours ago";
    case "returned_to_the_delivered_state":
      return "The move ended where this destination last saw it";
    case "renamed_by_the_source":
      return "An identical record arrived or left under another key in the same few hours";
    case "below_the_top_of_the_board":
      return "A place on a benchmark outside the leading three, and not the top changing hands";
    case "another_serving_of_a_known_model":
      return "A model already identified here, listed again under the way it is served";
    case "display_label_only":
      return "Nothing changed but the title the source displays";
    case "a_post_about_the_company_not_a_model":
      return "A newsroom post naming no model this deployment knows, and announcing none";
    case "another_tier_of_a_listed_model":
      return "A dated snapshot or billing tier of a model this catalogue already lists";
    case "published_by_a_followed_lab":
      return "Trending weights the lab's own account already published here";
    case "weights_with_nothing_to_run":
      return "Weights a followed lab published that declare no pipeline to run";
    case "weights_published_long_ago":
      return "A router serving weights published more than thirty days earlier";
    case "another_page_about_the_same_model":
      return "A vendor page naming a model this destination was told about in the last day";
    case "past_the_digest_limit":
      return "The hourly digest showed its first five stories and this one came after them";
    case "left_to_the_daily_recap":
      return "An OpenRouter price, which the daily recap reports as the day's net move";
    case "already_out_at_its_maker":
      return "A sighting of a model its maker's own catalogue already lists";
    case "names_only_known_models":
      return "A documentation change whose only tell is a model already known here";
    case "fixes_only_release":
      return "A tool build whose notes only fix things";
    case "a_reseller_filled_in_a_price":
      return "A reseller showing a price for a model it already listed without one";
    case "a_page_about_no_product":
      return "A new vendor page whose address names none of the vendor's products";
    case "trending_from_an_unfollowed_lab":
      return "A trending repository from a lab this service does not follow";
    case "alias_of_another_row":
      return "A row that points at whichever build is newest, not a model of its own";
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
