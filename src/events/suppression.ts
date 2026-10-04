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
  "a_field_the_source_started_sending",
  "one_change_across_the_whole_list",
  "known_here_for_weeks",
  "alias_of_another_row",
  "a_post_about_the_company_not_a_model",
  "the_readers_voted_this_source_down",
  "another_tier_of_a_listed_model",
  "already_listed_by_its_lab",
  "weights_with_nothing_to_run",
  "weights_published_long_ago",
  "another_page_about_the_same_model",
  "past_the_digest_limit",
  "left_to_the_daily_recap",
  "already_out_at_its_maker",
  "released_long_before_this_listing",
  "names_only_known_models",
  "fixes_only_release",
  "a_reseller_filled_in_a_price",
  "a_page_about_no_product",
  "a_deeper_page_of_one_tree",
  "trending_from_an_unfollowed_lab",
  "same_release_on_another_page",
  "announced_before_it_was_sighted",
  "the_modality_a_price_list_bills_for",
  "the_launch_it_follows_is_old_news",
  "another_effort_of_the_same_debut",
  "a_venues_own_hosting_window",
  "the_first_read_of_a_new_shape",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * The same decision in the words a reader would use, one per reason.
 *
 * A record rather than a switch so the type is the exhaustiveness check: a reason added to the list
 * above and left undescribed here does not compile, which is what the switch did by hand until it
 * outgrew the size a declaration is allowed.
 */
const SUPPRESSION_DETAIL: Record<SuppressionReason, string> = {
  no_reader_facing_change: "Nothing a reader would act on",
  scheduled_pricing_rotation: "Base rates rotated onto a tier this record already publishes",
  oscillating: "The value returned to one it held earlier today",
  flapping_in_and_out: "This entry has arrived on the board before and was announced then",
  already_told_by_another_source: "A source in another family already reported this within six hours",
  waiting_for_the_move_to_settle: "This destination heard about this subject less than six hours ago",
  returned_to_the_delivered_state: "The move ended where this destination last saw it",
  renamed_by_the_source: "An identical record arrived or left under another key in the same few hours",
  below_the_top_of_the_board: "A place on a benchmark outside the leading three, and not the top changing hands",
  another_serving_of_a_known_model: "A model already identified here, listed again under the way it is served",
  display_label_only: "Nothing changed but the title the source displays",
  a_field_the_source_started_sending:
    "The record gained a field it never carried, as did its neighbours: the schema moved, not the model",
  one_change_across_the_whole_list:
    "The same change reached several records of this source at once, and the first of them carries it",
  known_here_for_weeks: "A model this deployment has followed for weeks, listed at one more venue",
  alias_of_another_row: "A row that points at whichever build is newest, not a model of its own",
  a_post_about_the_company_not_a_model: "A newsroom post naming no model this deployment knows, and announcing none",
  the_readers_voted_this_source_down: "A post from a source the channel has voted against more often than for",
  another_tier_of_a_listed_model: "A dated snapshot or billing tier of a model this catalogue already lists",
  already_listed_by_its_lab: "Trending weights the lab's own account already lists here, which is where they were read",
  weights_with_nothing_to_run: "Weights a followed lab published that declare no pipeline to run",
  weights_published_long_ago: "Weights read here for the first time, published more than thirty days earlier",
  another_page_about_the_same_model: "A vendor page naming a model this destination was told about in the last day",
  past_the_digest_limit: "The hourly digest showed its first five stories and this one came after them",
  left_to_the_daily_recap: "An OpenRouter price, which the daily recap reports as the day's net move",
  already_out_at_its_maker: "A sighting of a model its maker's own catalogue already lists",
  released_long_before_this_listing: "A catalogue importing a model that was released more than a month ago",
  names_only_known_models: "A documentation change whose only tell is a model already known here",
  fixes_only_release: "A tool build whose notes only fix things",
  a_reseller_filled_in_a_price: "A reseller showing a price for a model it already listed without one",
  a_page_about_no_product: "A new vendor page whose address names none of the vendor's products",
  a_deeper_page_of_one_tree: "The page this sits under was published in the same read and carries the card",
  trending_from_an_unfollowed_lab: "A trending repository from a lab this service does not follow",
  same_release_on_another_page: "The same GitHub release already reached this destination from another page",
  announced_before_it_was_sighted:
    "Its maker's announcement already reached a channel; a later glimpse of it is not a sighting",
  the_modality_a_price_list_bills_for:
    "A price list charging a listed model for image or text tokens, which no other catalogue knows as a model",
  the_launch_it_follows_is_old_news: "A board placing more than two days after this model was first sighted here",
  another_effort_of_the_same_debut: "The same model measured at another reasoning effort, told under its best one",
  a_venues_own_hosting_window:
    "The day one venue stops serving a listing, which `lifecycle-deadlines` holds and no card claims as the model's end",
  the_first_read_of_a_new_shape:
    "The first poll that knew to ask about this line, which answers for everything already on it",
};

/**
 * Only one reason's words depend on the event: what a reader would have acted on is read off the
 * event itself, and falls back to the plain sentence when nothing there names a block.
 */
function suppressionDetail(event: Event, reason: SuppressionReason): string {
  if (reason === "no_reader_facing_change") return notificationBlock(event) ?? SUPPRESSION_DETAIL[reason];
  return SUPPRESSION_DETAIL[reason];
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
