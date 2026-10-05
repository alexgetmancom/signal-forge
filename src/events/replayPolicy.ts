import type { Database } from "bun:sqlite";
import { classify } from "./classify.js";
import { pageModel } from "./pageWorth.js";
import { retellsToldModels } from "./retoldWorth.js";
import type { SignalClass } from "./signals.js";
import { isMakersAnnouncement } from "./signals.js";
import { type BatchView, batchViewOf, standingReason } from "./standing.js";
import type { SuppressionReason } from "./suppression.js";
import {
  announcedBeforeSighted,
  announcementModel,
  announcementTold,
  pageModelsTold,
  releaseKey,
  releaseTold,
  repeatsDeliveredStory,
} from "./toldBefore.js";
import type { Event } from "./types.js";

/**
 * The events as every rule sees them: classed, and sharing one batch view.
 *
 * Both replays and `reports/why.ts` ask the standing questions of stored events, and all three got
 * this preamble wrong at least once. The class is not a column to be read: `events.signal` is
 * written by `classifyEmitted` on the live path, so it is absent on everything stored before that
 * existed -- 242 listing arrivals in production, every one of them older than 2026-09-21 -- and
 * five of the standing questions are about the class. A replay that reads the column answers those
 * five the wrong way on exactly the events an investigation into history asks about.
 *
 * So the preamble is named once and shared, rather than copied into each caller and then forgotten
 * in the next one. Reads only.
 */
export function asTheRulesSeeThem(
  db: Database,
  events: readonly Event[],
): { events: (Event & { signal: SignalClass })[]; view: BatchView } {
  const classed = events.map((event) => ({ ...event, signal: classify(db, event) }));
  return { events: classed, view: batchViewOf(db, classed) };
}

/**
 * The batch an event was actually in, so that a replay of one event is not a replay of a batch of
 * one.
 *
 * Four standing questions are about an event's siblings -- a field that arrived across the whole
 * list, a change that reached three records at once, a branch of pages read together. Replayed
 * alone the event has no siblings and all four answer no, which is not an answer but an artefact.
 * `batch_events` still knows who the siblings were, so they can be fetched instead of assumed; this
 * is the lookup `replayDestinationVerdicts` was already doing for its own `batch_id`.
 *
 * `reconstructed` is false for an event that never reached a batch, where a batch of one is the
 * truthful answer and the caller should say so rather than report four passes.
 */
export function theBatchItWasIn(db: Database, event: Event): { events: Event[]; reconstructed: boolean } {
  const batch = db
    .query<{ batch_id: number }, [number]>("SELECT batch_id FROM batch_events WHERE event_id=?")
    .get(event.id);
  if (!batch) return { events: [event], reconstructed: false };
  const siblings = db
    .query<Event, [number]>(
      "SELECT e.* FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
    )
    .all(batch.batch_id);
  return { events: siblings.length ? siblings : [event], reconstructed: siblings.length > 0 };
}

/**
 * The destination-independent half of the delivery policy, for replay: the class the rules give each
 * event and the standing reason, if any, that holds it back from everyone. The destination-dependent
 * checks (already told, oscillating, waiting to settle) read delivery history as it is now rather
 * than as it was, so they are left out rather than answered wrongly. Reads only.
 */
export function replayVerdicts(
  db: Database,
  events: readonly Event[],
): { eventId: number; signal: SignalClass; reason: SuppressionReason | null }[] {
  const { events: classed, view } = asTheRulesSeeThem(db, events);
  return classed.map((event) => ({ eventId: event.id, signal: event.signal, reason: standingReason(db, event, view) }));
}

/**
 * The same verdicts, plus the checks that ask what one destination was already told, each answered
 * against the history as it stood when the event arrived rather than as it stands now. Those four
 * -- the same release on another page, a story another source already told, a sighting of something
 * announced first, another page about the same model -- all hang off an earlier event, so a cutoff
 * on when that earlier event was detected reconstructs the answer faithfully enough to compare two
 * policies by.
 *
 * What it still cannot replay: whether a delivery that is 'sent' today was sent by then, since only
 * the current status is stored; oscillation and flapping, which read a record's own recent history
 * through helpers with no cutoff; and the waiting-to-settle hold, which needs the baseline this
 * destination last saw. Events held back by those keep their standing verdict here. Reads only.
 */
export function replayDestinationVerdicts(
  db: Database,
  events: readonly Event[],
  destinationId: string,
): { eventId: number; signal: SignalClass; reason: SuppressionReason | null }[] {
  const { events: classed, view } = asTheRulesSeeThem(db, events);
  const batchOf = (eventId: number): number =>
    db.query<{ batch_id: number }, [number]>("SELECT batch_id FROM batch_events WHERE event_id=?").get(eventId)
      ?.batch_id ?? -1;
  const storyOf = (eventId: number): number | undefined =>
    db.query<{ story_id: number }, [number]>("SELECT story_id FROM story_events WHERE event_id=?").get(eventId)
      ?.story_id;
  const releases = new Set<string>();
  const toldPages = new Set<string>();
  return classed.map((event) => {
    const asOf = event.detected_at;
    const at = Date.parse(asOf);
    const batchId = batchOf(event.id);
    const reason = ((): SuppressionReason | null => {
      const standing = standingReason(db, event, view);
      if (standing) return standing;
      const announcement = announcementModel(event);
      if (announcement && announcementTold(db, announcement, destinationId, batchId, at, asOf))
        return "same_release_on_another_page";
      const release = releaseKey(event);
      if (release && (releases.has(release) || releaseTold(db, release, destinationId, batchId, at, asOf)))
        return "same_release_on_another_page";
      if (
        !isMakersAnnouncement(event) &&
        repeatsDeliveredStory(db, event, destinationId, storyOf(event.id), batchId, asOf)
      )
        return "already_told_by_another_source";
      if (!isMakersAnnouncement(event) && retellsToldModels(db, event, destinationId, at, asOf))
        return "names_only_known_models";
      if (event.signal === "codename" && announcedBeforeSighted(db, event, storyOf(event.id), batchId))
        return "announced_before_it_was_sighted";
      const model = pageModel(event);
      if (model && (toldPages.has(model) || pageModelsTold(db, destinationId, batchId, at, asOf).has(model)))
        return "another_page_about_the_same_model";
      if (model) toldPages.add(model);
      if (release) releases.add(release);
      return null;
    })();
    return { eventId: event.id, signal: event.signal, reason };
  });
}
