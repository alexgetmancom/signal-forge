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
import { isTheFirstReadOfAShape } from "../sources/probeMemory.js";
import { isFixesOnlyRelease } from "./buildWorth.js";
import { anotherEffortLeadsThisDebut, followsAnOldLaunch } from "./debutAge.js";
import {
  isAliasRow,
  isAnotherServing,
  isAnotherSizeOfASightedName,
  isAnotherTierOfAListedModel,
  knownModelNames,
} from "./nameWorth.js";
import { isScheduledPricingRotation } from "./oscillation.js";
import { deeperPagesOfOneTree, isPageWithoutAProduct } from "./pageWorth.js";
import { isAResellerFillingInAPrice, isLeftToTheDailyRecap, isTheModalityOfAPricedModel } from "./priceWorth.js";
import { recordFor } from "./record.js";
import { wasPublishedLongBeforeWeReadIt } from "./releaseDate.js";
import { renamedEvents } from "./rename.js";
import { listsAnotherMakersModel } from "./resellers.js";
import {
  isAlreadyOutAtItsMaker,
  isARouteToAReleasedModel,
  namesOnlyKnownModels,
  wasReleasedLongBefore,
} from "./retoldWorth.js";
import { isModelSighting } from "./signals.js";
import type { SuppressionReason } from "./suppression.js";
import type { Event, RecordData } from "./types.js";
import { displayName } from "./variants.js";
import { isTrendingFromAnUnfollowedLab, isWeightsBesideTheRelease } from "./weightsWorth.js";
import { firstSightingBySubject, listingsBySubject, releasedSubjects, subjectKey } from "./witness.js";
import {
  addedFieldSignature,
  changeSignature,
  isAboutTheCompanyNotAModel,
  isAlreadyListedByItsLab,
  isAVenuesHostingWindow,
  isLabelOnlyChange,
  isMinorBoardMove,
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
  /** Pages of a tree published in one read that the shallowest address of it already told. */
  deeperPages: Set<number>;
  known: ReturnType<typeof knownModelNames>;
  listings: ReturnType<typeof listingsBySubject> | null;
  released: ReadonlySet<string>;
  sighted: (event: Event) => boolean;
  elsewhereOf: (event: Event) => string[];
};

/**
 * One question the standing judgement asks, and the reason it gives when the answer is yes.
 *
 * A list rather than a chain of `if`s because the order is the policy -- the first reason that
 * applies is the one a reader sees and the one that is stored -- and a chain can only be read by
 * running it. `why` replays this same list to say what each question answered about one event,
 * which is the half that used to require a full rehearsal against a copy of production.
 *
 * A check answers with a reason or with null, so the three questions a newsroom post is asked stay
 * one entry: they share a vote that costs a read, and splitting them would ask for it three times
 * on the delivery path.
 *
 * `fromTheBatch` marks a check whose answer is not a function of the event alone. Those read sets
 * that `batchViewOf` built from the event's siblings, so replaying one event by itself answers no
 * where the batch answered yes -- `why` says so rather than implying the event would speak.
 */
type StandingCheck = {
  name: string;
  fromTheBatch?: true;
  ask: (db: Database, event: Event, view: BatchView) => SuppressionReason | null;
};

/**
 * A check whose name is its reason, which is all but two of them: the question is asked, and if the
 * answer is yes that reason is the one recorded. Written as a helper so an entry is one line and
 * the list can be read as the policy it is.
 */
function held(
  reason: SuppressionReason,
  when: (db: Database, event: Event, view: BatchView) => boolean,
  fromTheBatch?: true,
): StandingCheck {
  return {
    name: reason,
    ...(fromTheBatch ? { fromTheBatch } : {}),
    ask: (db, e, v) => (when(db, e, v) ? reason : null),
  };
}

const STANDING_CHECKS: readonly StandingCheck[] = [
  held("renamed_by_the_source", (_db, e, v) => v.renamed.has(e.id), true),
  held("below_the_top_of_the_board", (_db, e) => isMinorBoardMove(e)),
  /**
   * A probe that has just learned a shape finds the whole line at once; see isTheFirstReadOfAShape.
   * Asked only of a page a probe found, because only a probe dates the shapes it asks about, and
   * the question costs a snapshot read.
   */
  held(
    "the_first_read_of_a_new_shape",
    (db, e) =>
      e.stream === "pages" &&
      e.source.startsWith("discovery:") &&
      e.kind === "new" &&
      isTheFirstReadOfAShape(db, e.source, e.entity_id, e.detected_at),
  ),
  // A board placing is the second half of a launch, and stops being one; see followsAnOldLaunch.
  held("the_launch_it_follows_is_old_news", (db, e) => followsAnOldLaunch(db, e)),
  // One model measured at five reasoning efforts is one debut; see anotherEffortLeadsThisDebut.
  held("another_effort_of_the_same_debut", (db, e) => anotherEffortLeadsThisDebut(db, e)),
  held("another_serving_of_a_known_model", (_db, e, v) => isAnotherServing(e, v.known)),
  {
    // Three reasons from one read: the vote costs a query, and splitting them would ask for it
    // three times on the delivery path.
    name: "what_a_newsroom_post_is_asked",
    ask: (db, e, v) => {
      if (e.signal !== "article" && e.signal !== "business") return null;
      // Jev reads the post the word rule can only pattern-match; see newsroomVote.
      const vote = e.stream === "news" ? newsroomVote(db, e.id) : null;
      if (vote === "recap") return "left_to_the_daily_recap";
      if (vote !== "speaks" && isAboutTheCompanyNotAModel(e, v.known)) return "a_post_about_the_company_not_a_model";
      // The readers' own verdict on the source, which Jev can overrule and a release never reaches;
      // see readersVote.
      if (vote !== "speaks" && e.stream === "news" && readersVote(db, e.source))
        return "the_readers_voted_this_source_down";
      return null;
    },
  },
  held("display_label_only", (_db, e) => isLabelOnlyChange(e)),
  held("a_field_the_source_started_sending", (_db, e, v) => v.schema.has(e.id), true),
  held("one_change_across_the_whole_list", (_db, e, v) => v.herd.has(e.id), true),
  held("known_here_for_weeks", (_db, e, v) => v.longKnown.has(e.id), true),
  held("alias_of_another_row", (_db, e) => isAliasRow(e)),
  held("another_tier_of_a_listed_model", (db, e) => isAnotherTierOfAListedModel(db, e)),
  held("another_size_of_a_sighted_name", (db, e) => isAnotherSizeOfASightedName(db, e)),
  held("the_modality_a_price_list_bills_for", (db, e) => isTheModalityOfAPricedModel(db, e)),
  held("already_listed_by_its_lab", (db, e) => isAlreadyListedByItsLab(db, e)),
  held("weights_with_nothing_to_run", (_db, e) => isWeightsBesideTheRelease(e)),
  held("published_long_before_we_read_it", (_db, e) =>
    wasPublishedLongBeforeWeReadIt(recordFor(e), e.stream, e.kind, e.detected_at, e.signal ?? null),
  ),
  held("scheduled_pricing_rotation", (_db, e) => isScheduledPricingRotation(e)),
  held("left_to_the_daily_recap", (_db, e) => isLeftToTheDailyRecap(e)),
  held("a_venues_own_hosting_window", (_db, e) => isAVenuesHostingWindow(e)),
  held("a_reseller_filled_in_a_price", (_db, e) => isAResellerFillingInAPrice(e)),
  held("a_page_about_no_product", (_db, e) => isPageWithoutAProduct(e)),
  held("a_deeper_page_of_one_tree", (_db, e, v) => v.deeperPages.has(e.id), true),
  held("trending_from_an_unfollowed_lab", (_db, e) => isTrendingFromAnUnfollowedLab(e)),
  // Two ways to the same reason, kept apart so `why` says which one answered.
  {
    name: "already_out_at_its_maker_elsewhere",
    ask: (_db, e, v) =>
      e.signal === "codename" && v.listings && v.sighted(e) && isAlreadyOutAtItsMaker(e, v.elsewhereOf(e))
        ? "already_out_at_its_maker"
        : null,
  },
  {
    name: "already_out_at_its_maker_by_route",
    ask: (_db, e, v) =>
      e.signal === "codename" && isARouteToAReleasedModel(e, v.released) ? "already_out_at_its_maker" : null,
  },
  held("released_long_before_this_listing", (db, e) => e.signal === "codename" && wasReleasedLongBefore(db, e)),
  held("names_only_known_models", (_db, e, v) => e.signal === "codename" && namesOnlyKnownModels(e, v.known)),
  held("fixes_only_release", (_db, e) => e.signal === "release" && isFixesOnlyRelease(e)),
];

/** The names of every standing question, in the order they are asked. */
export function standingCheckNames(): string[] {
  return STANDING_CHECKS.map((check) => check.name);
}

/** What every standing question answered about one event, in the order they are asked. */
export type StandingAnswer = { check: string; reason: SuppressionReason | null; fromTheBatch: boolean };

/**
 * Every question, asked. Stops at nothing, so a reader sees what the rules after the deciding one
 * would have said; the deciding one is the first with a reason.
 */
export function standingAnswers(db: Database, event: Event, view: BatchView): StandingAnswer[] {
  return STANDING_CHECKS.map((check) => ({
    check: check.name,
    reason: check.ask(db, event, view),
    fromTheBatch: check.fromTheBatch === true,
  }));
}

/**
 * Why an event is not worth a card to anyone, whichever destination is asking, or null when nothing
 * about the event itself holds it back. Checks that depend on what a destination has already been
 * told stay with the destination. The order is the order reasons are recorded in: the first that
 * applies is the one a reader sees.
 */
export function standingReason(db: Database, event: Event, view: BatchView): SuppressionReason | null {
  for (const check of STANDING_CHECKS) {
    const reason = check.ask(db, event, view);
    if (reason) return reason;
  }
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

  // A sitemap publishes a branch rather than a page, and the root of it is the one card; the same
  // reading of a batch as `herd`, applied to an address. See deeperPagesOfOneTree.
  const deeperPages = deeperPagesOfOneTree(events);
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
  return { renamed, schema, herd, longKnown, deeperPages, known, listings, released, sighted, elsewhereOf };
}
