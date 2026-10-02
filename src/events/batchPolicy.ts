import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import type { BatchTarget } from "./batchParts.js";
import { deliveryBaseline, withBaseline } from "./cooldown.js";
import { corroborationOfEvent } from "./corroboration.js";
import { prepareLifecycleReminder, preparePromotion, prepareRecap } from "./digests.js";
import { hasNotificationContent } from "./notification.js";
import { departedAs, isOscillating, isReappearance } from "./oscillation.js";
import { pageModel } from "./pageWorth.js";
import { borrowedFacts } from "./priceWorth.js";
import { parseRecord } from "./recordBody.js";
import type { LeadTime } from "./render/facts.js";
import { stealthSubject } from "./resellers.js";
import { retellsToldModels } from "./retoldWorth.js";
import { isMakersAnnouncement } from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import { awaitingJudgement, awaitingSummary, batchViewOf, standingReason } from "./standing.js";
import type { SuppressionReason } from "./suppression.js";
import { clearSuppression, recordSuppression } from "./suppression.js";
import type { Announcement } from "./toldBefore.js";
import {
  announcedBeforeSighted,
  announcementModel,
  announcementOf,
  announcementsBySubject,
  announcementTold,
  pageModelsTold,
  releaseKey,
  releaseTold,
  repeatsDeliveredStory,
} from "./toldBefore.js";
import type { Event } from "./types.js";
import { rosterSiblings } from "./witness.js";

/**
 * How long each of these events had already been visible through a different kind of source.
 *
 * Read once per batch from the story the event belongs to. Only an earlier event from another
 * source family counts: a collector that sees its own record twice has not led anything, and an
 * hour is the floor because two sources polled minutes apart are simultaneous in every sense a
 * reader cares about.
 */
function leadTimes(db: Database, storyIds: Map<number, number>, events: Event[]): Map<number, LeadTime> {
  const leads = new Map<number, LeadTime>();
  const stories = [...new Set(storyIds.values())];
  if (!stories.length) return leads;
  const rows = db
    .query<
      { story_id: number; source: string; stream: string; kind: string; detected_at: string; name: string | null },
      number[]
    >(
      `SELECT se.story_id,e.source,e.stream,e.kind,e.detected_at,
         COALESCE(json_extract(e.after_json,'$.name'),json_extract(e.before_json,'$.name'),e.entity_id) AS name
       FROM story_events se JOIN events e ON e.id=se.event_id
       WHERE se.story_id IN (${stories.map(() => "?").join(",")})`,
    )
    .all(...stories);
  for (const event of events) {
    const storyId = storyIds.get(event.id);
    if (storyId === undefined) continue;
    const family = sourceFamily(event.source, event.stream);
    const detectedAt = Date.parse(event.detected_at);
    const earliest = rows
      .filter((row) => row.story_id === storyId && sourceFamily(row.source, row.stream) !== family)
      .map((row) => ({ at: Date.parse(row.detected_at), kind: row.kind, source: row.source, name: row.name }))
      .filter((row) => Number.isFinite(row.at) && row.at < detectedAt)
      .sort((one, other) => one.at - other.at)[0];
    // A rank moving is a model that was already there: "Traced 8 days earlier" for Gemini 3.8 Flash
    // measured the start of this database's history, not a source that spoke first.
    if (earliest?.kind !== "new" || !Number.isFinite(detectedAt)) continue;
    const hours = (detectedAt - earliest.at) / 3_600_000;
    if (hours >= 1)
      leads.set(event.id, {
        hours,
        source: earliest.source,
        ...(earliest.name ? { name: String(earliest.name) } : {}),
      });
  }
  return leads;
}

/** A batch that is ready to be prepared, as the scheduler's own columns describe it. */
export type ReadyBatch = {
  id: number;
  digest: number;
  source: string;
  kind: "event" | "lifecycle_reminder" | "weekly_recap" | "promotion";
  context_json: string | null;
};

/** An event as a batch carries it: the class it was batched under, and the link the card points at. */
export type BatchEvent = Event & { url: string };

/**
 * One batch for one destination, and everything both halves of the policy read.
 *
 * The delivery policy is two questions -- which events speak here, and what the message that carries
 * them looks like -- and each of them needs most of the same dozen readings. Passing them as one
 * value is what lets each question be a function with a name instead of a paragraph inside a loop
 * inside a loop.
 */
export type Delivering = {
  db: Database;
  batch: ReadyBatch;
  target: BatchTarget;
  destination: Destination;
  events: BatchEvent[];
  summaries: Map<number, string>;
  storyIds: Map<number, number>;
  leads: Map<number, LeadTime>;
  batchView: ReturnType<typeof batchViewOf>;
  vendorRoles: Record<string, string>;
  allSignalsRole: string | undefined;
  now: number;
};

/**
 * Which of a batch's events speak to this destination, and a written reason for each that does not.
 *
 * Every rule here is about one event and one destination, and every one of them writes down why it
 * silenced what it silenced: a card that was not sent and a card that was never considered look the
 * same in the channel, and only one of them can be explained afterwards.
 */
export function speakingEvents(work: Delivering): BatchEvent[] {
  const { db, batch, target, destination, events, storyIds, batchView, now } = work;
  const subscribed = new Set<string>(destination.signals);
  // An unclassified event is subscribed to by nobody: a destination subscribes to classes, and an
  // event with no class is not in any of them.
  const wanted = (event: BatchEvent) => event.signal !== null && subscribed.has(event.signal);
  // Every event subscribed to by this destination leaves either a card or a written reason.
  const quiet = (event: Event, reason: SuppressionReason): never[] => {
    recordSuppression(db, event, target.destination_id, batch.id, reason, now);
    return [];
  };
  const toldPages = events.some((event) => pageModel(event) && wanted(event))
    ? pageModelsTold(db, target.destination_id, batch.id, now)
    : new Set<string>();
  const releases = new Set<string>();
  const speaking = events.filter(wanted).flatMap((event) => {
    // A corroboration card is not the event speaking, so the reasons the event was quiet do
    // not apply to it. Each of them is a verdict about one sighting -- a board move outside
    // the top three, another serving of a known model -- and every one stays correct; the
    // card is about the accumulation, which no per-event rule was ever asked about. Without
    // this the threshold fires into a batch the same rules then silence again, which is what
    // happened to all four cards raised in the week to 2026-09-20.
    if (corroborationOfEvent(db, event.id)) return [event];
    // Routine drift is judged against the last state this destination actually saw, so that
    // steps too small to report on their own still add up to one card. Only routine drift:
    // an event the policy already decided is worth interrupting a reader for, such as a
    // benchmark changing hands at the top, is news every time it happens.
    const drifting = batch.digest && event.signal === "change" && event.kind === "changed";
    const baseline = drifting ? deliveryBaseline(db, event, target.destination_id, batch.id, now) : null;
    const caughtUp = baseline ? { ...event, ...withBaseline(event, baseline) } : event;
    if (!hasNotificationContent(caughtUp))
      return quiet(
        caughtUp,
        baseline?.sinceJson && hasNotificationContent(event)
          ? "returned_to_the_delivered_state"
          : "no_reader_facing_change",
      );
    const standing = standingReason(db, event, batchView);
    if (standing) return quiet(event, standing);
    const announcement = announcementModel(event);
    if (announcement && announcementTold(db, announcement, target.destination_id, batch.id, now))
      return quiet(event, "same_release_on_another_page");
    const release = releaseKey(event);
    if (release && (releases.has(release) || releaseTold(db, release, target.destination_id, batch.id, now)))
      return quiet(event, "same_release_on_another_page");
    if (isOscillating(db, event, now)) return quiet(event, "oscillating");
    if (isReappearance(db, event, now)) return quiet(event, "flapping_in_and_out");
    // A maker's own post about its own model is never a repeat: it is the link the card
    // could not carry, and a reader who just heard the model exists wants it in the next
    // minute rather than folded into a message they have already read.
    if (
      !isMakersAnnouncement(event) &&
      repeatsDeliveredStory(db, event, target.destination_id, storyIds.get(event.id), batch.id)
    )
      return quiet(event, "already_told_by_another_source");
    if (!isMakersAnnouncement(event) && retellsToldModels(db, event, target.destination_id, now))
      return quiet(event, "names_only_known_models");
    if (event.signal === "codename" && announcedBeforeSighted(db, event, storyIds.get(event.id), batch.id))
      return quiet(event, "announced_before_it_was_sighted");
    // A number that keeps moving waits, then speaks once about the whole move it missed.
    if (baseline?.hold) return quiet(event, "waiting_for_the_move_to_settle");
    const model = pageModel(event);
    if (model && toldPages.has(model)) return quiet(event, "another_page_about_the_same_model");
    if (model) toldPages.add(model);
    if (release) releases.add(release);
    return [caughtUp];
  });
  for (const event of speaking) clearSuppression(db, event.id, target.destination_id);
  return speaking;
}

/**
 * What a card can say that its own event did not carry: a return, facts borrowed from a fuller row,
 * and who else is serving the same model.
 */
export function withBorrowedContext(work: Delivering, speaking: BatchEvent[]): void {
  const { db, batchView, now } = work;
  const { listings, sighted, elsewhereOf } = batchView;
  // Only a sighting can be of something the maker has already announced, and only a batch holding
  // one pays for the reading.
  const announcements = speaking.some((event) => event.signal === "codename")
    ? announcementsBySubject(db, now)
    : new Map<string, Announcement>();
  for (const event of speaking) {
    const returned = departedAs(db, event, now);
    if (returned) Object.assign(event, { returned });
    if (event.signal === "codename") {
      const announced = announcementOf(event, announcements);
      if (announced) Object.assign(event, { announced });
    }
    // Every launch, not only a stealth one: Anthropic's own row for Claude Opus 5.5 carried
    // neither a context length nor a price, and the card went out with the bottom of its
    // picture empty while OpenRouter had both.
    if (event.signal === "launch") {
      const borrowed = borrowedFacts(db, event, stealthSubject(event));
      if (Object.keys(borrowed).length) Object.assign(event, { borrowed });
    }
    if (listings && sighted(event)) {
      const record = parseRecord(event.after_json);
      const elsewhere = elsewhereOf(event);
      // An arena entry nobody lists is the ordinary case and its card already says so.
      if (elsewhere.length || event.stream !== "arena") Object.assign(event, { elsewhere });
      if (event.stream === "arena" && record) {
        const siblings = rosterSiblings(db, event.source, event.entity_id, String(record.name ?? ""), record.maker);
        if (siblings.length) Object.assign(event, { siblings });
      }
    }
  }
}

/**
 * Everything one batch is prepared from, or nothing when it is not to be prepared.
 *
 * Two of the three reasons to walk away are not failures: a batch whose card is still waiting for a
 * sentence or a judgement is prepared on a later pass, and a promotion, a recap or a lifecycle
 * reminder is a different message built elsewhere. All three leave the batch unsealed, which is what
 * brings it back.
 */
export function batchReading(
  db: Database,
  batch: ReadyBatch,
  now: number,
): {
  events: BatchEvent[];
  targets: BatchTarget[];
  summaries: Map<number, string>;
  storyIds: Map<number, number>;
  leads: Map<number, LeadTime>;
  batchView: ReturnType<typeof batchViewOf>;
} | null {
  const events = db
    .query<BatchEvent, [number]>(
      "SELECT e.*,NULLIF(b.signal,'') AS signal,COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),b.url) AS url FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
    )
    .all(batch.id);
  // An immediate batch is rendered within seconds of the poll that created it, and the message
  // body is stored at render time. A package release bump carries nothing but a version number
  // until its release notes are fetched and summarised, so rendering it on sight ships the empty
  // version of the card and seals the batch before the sentence can ever arrive. Hourly digests
  // never hit this because they sit unsealed for an hour; every delivered package release did.
  if (batch.kind === "event" && !batch.digest && awaitingSummary(db, events, now)) return null;
  // And the same wait for a judgement, which decides whether a vendor's post speaks at all.
  if (batch.kind === "event" && !batch.digest && awaitingJudgement(db, events, now)) return null;
  const targets = db
    .query<{ destination_id: string; destination_json: string }, [number]>(
      "SELECT destination_id,destination_json FROM batch_targets WHERE batch_id=? ORDER BY rowid",
    )
    .all(batch.id);
  if (batch.kind === "promotion") {
    preparePromotion(db, batch, targets, now);
    return null;
  }
  if (batch.kind === "weekly_recap") {
    prepareRecap(db, batch, targets, now);
    return null;
  }
  if (batch.kind === "lifecycle_reminder") {
    prepareLifecycleReminder(db, batch, events, targets, now);
    return null;
  }
  const summaries = new Map(
    db
      .query<{ event_id: number; text: string }, []>("SELECT event_id,text FROM summaries")
      .all()
      .map((row) => [row.event_id, row.text] as const),
  );
  const storyIds = new Map(
    db
      .query<{ event_id: number; story_id: number }, [number]>(
        "SELECT se.event_id,se.story_id FROM story_events se JOIN batch_events be ON be.event_id=se.event_id WHERE be.batch_id=?",
      )
      .all(batch.id)
      .map((row) => [row.event_id, row.story_id] as const),
  );
  const leads = leadTimes(db, storyIds, events);
  const batchView = batchViewOf(db, events);
  return { events, targets, summaries, storyIds, leads, batchView };
}
