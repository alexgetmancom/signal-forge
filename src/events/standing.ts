/**
 * Whether a batch is ready to speak, and the reasons that hold it back from everybody.
 *
 * Two halves of one question. The grace gates ask whether a batch is still waiting for something it
 * asked for -- a sentence being written, a verdict not yet returned -- and hold it rather than
 * speaking without it. `standingReason` asks whether the batch should speak at all, which is the
 * destination-independent half of the delivery policy: a reason found here holds for every channel,
 * and `replayVerdicts` replays exactly this much. `batchViewOf` is what both read, built once per
 * batch and shared by its destinations. Moved out of batching.ts unchanged.
 */

import type { Database } from "bun:sqlite";
import { newsroomVote, readersVote } from "../insights.js";
import { judgementOf } from "../jev.js";
import { isScheduledPricingRotation } from "./oscillation.js";
import { renamedEvents } from "./rename.js";
import { isModelSighting, listsAnotherMakersModel } from "./signals.js";
import type { SuppressionReason } from "./suppression.js";
import type { Event, RecordData } from "./types.js";
import { displayName } from "./variants.js";
import { firstSightingBySubject, listingsBySubject, releasedSubjects, subjectKey } from "./witness.js";
import {
  addedFieldSignature,
  changeSignature,
  isAboutTheCompanyNotAModel,
  isAliasRow,
  isAlreadyOutAtItsMaker,
  isAnotherServing,
  isAnotherTierOfAListedModel,
  isAResellerFillingInAPrice,
  isARouteToAReleasedModel,
  isFixesOnlyRelease,
  isLabelOnlyChange,
  isLeftToTheDailyRecap,
  isLongPublishedWeights,
  isMinorBoardMove,
  isPageWithoutAProduct,
  isPublishedByAFollowedLab,
  isTheModalityOfAPricedModel,
  isTrendingFromAnUnfollowedLab,
  isWeightsBesideTheRelease,
  knownModelNames,
  namesOnlyKnownModels,
  wasReleasedLongBefore,
} from "./worth.js";

/** How long a model has to have been followed here before one more venue listing it is only a line. */
const LONG_KNOWN_MS = 30 * 24 * 3_600_000;

/** How long an immediate batch waits for a sentence that is still being written. */
const SUMMARY_GRACE_MS = 90_000;

/**
 * True while a package release in this batch could still gain a summary and the batch is young
 * enough to wait for it. Only packages wait: a version bump renders to "2.1.268 → 2.1.269" and
 * nothing else, while a large page diff already says something without a sentence. An event that
 * was attempted — recorded in `deepseek_usage` whatever the outcome — is finished waiting, so a
 * provider failure delays a card by one cycle and never strands it.
 */
export function awaitingSummary(db: Database, events: readonly Event[], now: number): boolean {
  return events.some((event) => {
    if (event.stream !== "packages") return false;
    if (Date.parse(event.detected_at) + SUMMARY_GRACE_MS <= now) return false;
    const attempted = db
      .query<{ n: number }, [number]>(
        "SELECT (SELECT COUNT(*) FROM summaries WHERE event_id=?1) + (SELECT COUNT(*) FROM deepseek_usage WHERE event_id=?1) AS n",
      )
      .get(event.id);
    return (attempted?.n ?? 0) === 0;
  });
}

/**
 * How long an immediate news batch waits for Jev to read it.
 *
 * The vote in `standingReason` was almost dead code without this: judging runs on a five-minute
 * worker and a news card is built seconds after the poll, so the reader that was meant to overrule
 * a two-word rule had almost never seen the post by the time the rule decided. Three minutes is
 * longer than the judge's own cycle and shorter than any news is stale.
 */
const JUDGEMENT_GRACE_MS = 180_000;

/**
 * True while a vendor's post in this batch could still gain a judgement and the batch is young
 * enough to wait. Only newsroom posts wait, because they are the only events a judgement changes
 * the fate of. A deployment whose judge is silent -- no key, a spent daily allowance, an upstream
 * that is down -- has judged nothing in a day and waits for nothing, so a card is never stranded
 * on a reader that is never coming.
 */
export function awaitingJudgement(db: Database, events: readonly Event[], now: number): boolean {
  const posts = events.filter(
    (event) => event.stream === "news" && (event.signal === "article" || event.signal === "business"),
  );
  const young = posts.filter((event) => Date.parse(event.detected_at) + JUDGEMENT_GRACE_MS > now);
  if (!young.length) return false;
  const judging = db
    .query<{ one: number }, [string]>("SELECT 1 one FROM event_evaluations WHERE evaluated_at>=? LIMIT 1")
    .get(new Date(now - 24 * 3_600_000).toISOString());
  if (!judging) return false;
  return young.some((event) => !judgementOf(db, event.id));
}

/** What a batch knows about its events that every destination's judgement reads. */
export type BatchView = {
  renamed: Set<number>;
  schema: Set<number>;
  herd: Set<number>;
  longKnown: Set<number>;
  known: ReturnType<typeof knownModelNames>;
  listings: ReturnType<typeof listingsBySubject> | null;
  released: ReadonlySet<string>;
  sighted: (event: Event) => boolean;
  elsewhereOf: (event: Event) => string[];
};

/**
 * Why an event is not worth a card to anyone, whichever destination is asking, or null when nothing
 * about the event itself holds it back. Checks that depend on what a destination has already been
 * told stay with the destination. The order is the order reasons are recorded in: the first that
 * applies is the one a reader sees.
 */
export function standingReason(db: Database, event: Event, view: BatchView): SuppressionReason | null {
  if (view.renamed.has(event.id)) return "renamed_by_the_source";
  if (isMinorBoardMove(event)) return "below_the_top_of_the_board";
  if (isAnotherServing(event, view.known)) return "another_serving_of_a_known_model";
  if (event.signal === "article" || event.signal === "business") {
    // Jev reads the post the word rule can only pattern-match; see newsroomVote.
    const vote = event.stream === "news" ? newsroomVote(db, event.id) : null;
    if (vote === "recap") return "left_to_the_daily_recap";
    if (vote !== "speaks" && isAboutTheCompanyNotAModel(event, view.known))
      return "a_post_about_the_company_not_a_model";
    // The readers' own verdict on the source, which Jev can overrule and a release never reaches;
    // see readersVote.
    if (vote !== "speaks" && event.stream === "news" && readersVote(db, event.source))
      return "the_readers_voted_this_source_down";
  }
  if (isLabelOnlyChange(event)) return "display_label_only";
  if (view.schema.has(event.id)) return "a_field_the_source_started_sending";
  if (view.herd.has(event.id)) return "one_change_across_the_whole_list";
  if (view.longKnown.has(event.id)) return "known_here_for_weeks";
  if (isAliasRow(event)) return "alias_of_another_row";
  if (isAnotherTierOfAListedModel(db, event)) return "another_tier_of_a_listed_model";
  if (isTheModalityOfAPricedModel(db, event)) return "the_modality_a_price_list_bills_for";
  if (isPublishedByAFollowedLab(db, event)) return "published_by_a_followed_lab";
  if (isWeightsBesideTheRelease(event)) return "weights_with_nothing_to_run";
  if (isLongPublishedWeights(event)) return "weights_published_long_ago";
  if (isScheduledPricingRotation(event)) return "scheduled_pricing_rotation";
  if (isLeftToTheDailyRecap(event)) return "left_to_the_daily_recap";
  if (isAResellerFillingInAPrice(event)) return "a_reseller_filled_in_a_price";
  if (isPageWithoutAProduct(event)) return "a_page_about_no_product";
  if (isTrendingFromAnUnfollowedLab(event)) return "trending_from_an_unfollowed_lab";
  if (
    event.signal === "codename" &&
    view.listings &&
    view.sighted(event) &&
    isAlreadyOutAtItsMaker(event, view.elsewhereOf(event))
  )
    return "already_out_at_its_maker";
  if (event.signal === "codename" && isARouteToAReleasedModel(event, view.released)) return "already_out_at_its_maker";
  if (event.signal === "codename" && wasReleasedLongBefore(db, event)) return "released_long_before_this_listing";
  if (event.signal === "codename" && namesOnlyKnownModels(event, view.known)) return "names_only_known_models";
  if (event.signal === "release" && isFixesOnlyRelease(event)) return "fixes_only_release";
  return null;
}

/** Everything the standing judgement reads about a batch, built once and shared by its destinations. */
export function batchViewOf(db: Database, events: readonly Event[]): BatchView {
  // A re-keyed catalogue speaks once per row, twice: the row that left and the identical row that
  // arrived. Found once per batch, because the answer does not depend on the destination.
  const renamed = renamedEvents(db, events);
  // A field appearing on one record is the source saying something about that record; the same
  // field appearing on several at once is the shape of the data changing underneath us.
  const bySignature = new Map<string, number[]>();
  for (const event of events) {
    const signature = addedFieldSignature(event);
    if (signature) bySignature.set(signature, [...(bySignature.get(signature) ?? []), event.id]);
  }
  const schema = new Set([...bySignature.values()].filter((ids) => ids.length > 1).flat());
  // And a change that reached several records of one source in the same read is one thing the
  // source did: the first record carries the card, the rest of the herd is the same sentence.
  const byChange = new Map<string, number[]>();
  for (const event of events) {
    const signature = changeSignature(event);
    if (signature)
      byChange.set(`${event.source}\u0000${signature}`, [
        ...(byChange.get(`${event.source}\u0000${signature}`) ?? []),
        event.id,
      ]);
  }
  const herd = new Set([...byChange.values()].filter((ids) => ids.length >= 3).flatMap((ids) => ids.slice(1)));
  // A platform listing a model this deployment has been following for weeks is a venue catching
  // up, not a release. Command A+ reached the public channel on 2026-09-22 as a launch; Cohere had
  // shipped it in May. Read from the story, which is where every source's word on a model meets.
  const catchingUp = events.filter(
    (event) =>
      event.kind === "new" && ["api-models", "openrouter"].includes(event.stream) && listsAnotherMakersModel(event),
  );
  const longKnown = new Set<number>();
  if (catchingUp.length) {
    const first = firstSightingBySubject(db);
    for (const event of catchingUp) {
      const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
      const keys = [
        ...new Set([subjectKey(event.entity_id), subjectKey(displayName(String(record?.name ?? event.entity_id)))]),
      ];
      const seen = keys
        .map((key) => first.get(key))
        .filter((row): row is { at: number; source: string } => row !== undefined && row.source !== event.source)
        .sort((one, other) => one.at - other.at)[0];
      if (seen && Date.parse(event.detected_at) - seen.at > LONG_KNOWN_MS) longKnown.add(event.id);
    }
  }

  // A sighting from a platform or a registry says where else the model already is; read once
  // per batch, and only when a card will need it.
  const sighted = (event: Event) =>
    event.kind === "new" &&
    (listsAnotherMakersModel(event) || event.source.startsWith("discovery:huggingface") || event.stream === "arena");
  const listings = events.some(sighted) ? listingsBySubject(db) : null;
  /** The other catalogues that already carry a sighted model, by the card's own name for it. */
  const elsewhereOf = (event: Event): string[] => {
    const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const name = displayName(String(record?.name ?? event.entity_id));
    const keys = new Set([subjectKey(event.entity_id), subjectKey(name)]);
    return [...new Set([...keys].flatMap((key) => [...(listings?.get(key) ?? [])]))]
      .filter((source) => source !== event.source)
      .sort();
  };
  // Read once per batch: the question is about the event, not about the destination. A repository
  // sighting asks it too, since `isAnotherServing` reads a model answering in a discussion against
  // the same catalogues it reads an arena seat against.
  const known = events.some(
    (event) =>
      ["arena", "web"].includes(event.stream) ||
      isModelSighting(event) ||
      event.signal === "article" ||
      event.signal === "business",
  )
    ? knownModelNames(db)
    : [];
  // Only a sighting can be a route to something already out, and only a batch that holds one pays
  // for the reading.
  const released = events.some((event) => event.signal === "codename" && event.kind === "new")
    ? releasedSubjects(db)
    : new Set<string>();
  return { renamed, schema, herd, longKnown, known, listings, released, sighted, elsewhereOf };
}
