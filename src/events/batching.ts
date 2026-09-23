import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { promotionContextSchema } from "../promotion.js";
import { type RecapContext, recapContextSchema } from "../recap.js";
import { sourceLabel } from "../sources/labels.js";
import { clip } from "../text.js";
import { breakoutLine, breakoutOf } from "./breakouts.js";
import { splitMessage } from "./canonical.js";
import { classify } from "./classify.js";
import { CONFIDENCE_LEVELS } from "./confidence.js";
import { deliveryBaseline, withBaseline } from "./cooldown.js";
import { corroborationLine, corroborationOfEvent } from "./corroboration.js";
import { vendorOf } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { departedAs, isOscillating, isReappearance, isScheduledPricingRotation } from "./oscillation.js";
import { renamedEvents } from "./rename.js";
import { type Attachment, eventAttachment } from "./render/attachment.js";
import type { Banner } from "./render/banner.js";
import { oneMessage } from "./render/budget.js";
import { eventEmbed, isRoster, rosterEmbed } from "./render/discord.js";
import type { LeadTime } from "./render/facts.js";
import {
  parseLifecycleReminderContext,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
  renderRecapEmbed,
  renderRecapLines,
} from "./render/lifecycle.js";
import { vendorLogo } from "./render/logos.js";
import { renderStoryText, type StoryRenderEvent, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import {
  isMakersAnnouncement,
  isStealthLaunch,
  listsAnotherMakersModel,
  pingWorthy,
  type SignalClass,
  stealthSubject,
} from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import { clearSuppression, recordSuppression, type SuppressionReason } from "./suppression.js";
import type { Event, RecordData } from "./types.js";
import { displayName } from "./variants.js";
import { firstSightingBySubject, listingsBySubject, rosterSiblings, subjectKey } from "./witness.js";
import {
  addedFieldSignature,
  borrowedFacts,
  changeSignature,
  isAboutTheCompanyNotAModel,
  isAliasRow,
  isAlreadyOutAtItsMaker,
  isAnotherServing,
  isAnotherTierOfAListedModel,
  isAResellerFillingInAPrice,
  isFixesOnlyRelease,
  isLabelOnlyChange,
  isLeftToTheDailyRecap,
  isLongPublishedWeights,
  isMinorBoardMove,
  isPageWithoutAProduct,
  isPublishedByAFollowedLab,
  isTrendingFromAnUnfollowedLab,
  isWeightsBesideTheRelease,
  knownModelNames,
  namesOnlyKnownModels,
  pageModel,
  retellsToldModels,
  wasReleasedLongBefore,
} from "./worth.js";

const DUPLICATE_STORY_WINDOW_MS = 6 * 3_600_000;
/** How long a model has to have been followed here before one more venue listing it is only a line. */
const LONG_KNOWN_MS = 30 * 24 * 3_600_000;
/** How many stories an hourly digest shows before it stops being read at all. */
const DIGEST_STORIES = 5;
/** A digest tells separate stories, so it may show a few cards; anything else shows one. */
const DIGEST_EMBEDS = 3;
const SEPARATOR = "\n\n────────\n\n";

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

/**
 * The message this destination already used to tell the story these events belong to.
 *
 * The point is the payoff: a codename sighted on an arena means little until the day it resolves,
 * and a reveal that hangs off the original sighting shows the reader the whole arc in one place.
 * Only a message that was actually sent can be referenced, and only the earliest one, so the thread
 * grows from the first word rather than from the last.
 */
function firstTelling(
  db: Database,
  events: Event[],
  storyIds: Map<number, number>,
  destinationId: string,
): string | null {
  const stories = [...new Set(events.map((event) => storyIds.get(event.id)).filter((id) => id !== undefined))];
  // The same record seen again is the other continuation, and the one the arena renames travel on:
  // `spicy-mayo` becoming `Gemini 4 Ultra` is a new subject and so a new story, while the entry it
  // was observed in never changed.
  const subjects = [...new Set(events.map((event) => `${event.source}\u0000${event.entity_id}`))];
  if (stories.length > 1 || subjects.length !== 1) return null;
  const [source, entityId] = (subjects[0] as string).split("\u0000");
  const carried = new Set(events.map((event) => event.id));
  const told = db
    .query<{ external_id: string; event_id: number }, (string | number)[]>(
      `SELECT d.external_id,de.event_id FROM delivery_events de
       JOIN deliveries d ON d.id=de.delivery_id
       JOIN events e ON e.id=de.event_id
       LEFT JOIN story_events se ON se.event_id=e.id
       WHERE d.destination_id=? AND d.status='sent' AND d.external_id IS NOT NULL
         AND ((e.source=? AND e.entity_id=?) ${stories.length ? "OR se.story_id=?" : ""})
       ORDER BY d.id`,
    )
    .all(...[destinationId, source as string, entityId as string, ...(stories.length ? [stories[0] as number] : [])]);
  return told.find((row) => !carried.has(row.event_id))?.external_id ?? null;
}

/** How long one GitHub release stays the same news for one destination. */
const RELEASE_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * The GitHub release a record stands for, whichever page carried it. OpenAI's Codex changelog links
 * each entry as `#github-release-<id>` while the repository's releases feed keys the same release by
 * `<id>`, so 0.155.1 reached #signals twice on 2026-09-18.
 */
function releaseKey(event: Event & { signal: string }): string | null {
  // One link per model. Grok 4.7 was announced on 2026-09-21 by xAI's release notes and by two of
  // its own pages within seventy minutes of the catalogue card; a reader needs the first of them.
  const announcement = announcementModel(event);
  if (announcement) return announcement;
  if (event.signal !== "release") return null;
  const linked = /#github-release-(\d+)$/.exec(event.entity_id);
  if (linked) return linked[1] as string;
  if (/^github:[^:]+:releases$/.test(event.source) && /^\d+$/.test(event.entity_id)) return event.entity_id;
  return null;
}

/**
 * The model a maker's own announcement is about, for an event that is one: its post's title, or the
 * slug of the page it published. Null when the event is not an announcement of the maker's own.
 */
function announcementModel(event: Event & { signal: string }): string | null {
  // One stealth model, however many venues list it in the same hour, and under whichever name:
  // OpenCode called it `space-bunny-free` and OpenRouter `stealth/space-bunny-alpha`.
  if (isStealthLaunch(event)) return `stealth:${stealthSubject(event)}`;
  const isPage = event.signal === "release" && (event.stream === "pages" || event.source.endsWith("-sitemap"));
  if (!isPage && !isMakersAnnouncement(event)) return null;
  const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const slug = isPage
    ? (event.entity_id.split("?")[0]?.replace(/\/+$/, "").split("/").at(-1) ?? "")
    : // A post is titled the way a post is: the model is what is left once the verb is taken off.
      String(record?.name ?? event.entity_id).replace(/^(?:introducing|announcing|meet|now available:?)\s+/i, "");
  const key = subjectKey(displayName(slug));
  return key ? `announce:${key}` : null;
}

/**
 * A cutoff for replay: count only what had already been detected when the event under judgement
 * was. Undefined in the delivery path, where "already" means now and the question is being asked
 * for the first time.
 */
type AsOf = string | undefined;

function releaseTold(
  db: Database,
  key: string,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): boolean {
  const since = new Date(now - RELEASE_WINDOW_MS).toISOString();
  return Boolean(
    db
      .query(
        `SELECT 1 FROM batch_events be
         JOIN events e ON e.id=be.event_id
         JOIN deliveries d ON d.batch_id=be.batch_id
         WHERE be.batch_id<>? AND d.destination_id=? AND e.detected_at>=? ${asOf ? "AND e.detected_at<?" : ""}
           AND ((e.source LIKE 'github:%:releases' AND e.entity_id=?) OR e.entity_id LIKE ?)
           AND d.status IN ('pending','sending','sent','ambiguous','verification_required')
         LIMIT 1`,
      )
      .get(...[batchId, destinationId, since, ...(asOf ? [asOf] : []), key, `%#github-release-${key}`]),
  );
}

/** How long one model's announcement stays the same link for one destination. */
const ANNOUNCEMENT_WINDOW_MS = 3 * 24 * 3_600_000;

/**
 * Whether this destination already carries a maker's announcement of the same model.
 *
 * The GitHub release guard next to this one matches on a release id, which an announcement has no
 * equivalent of: xAI's release notes, its docs page and its model page each call Grok 4.7 something
 * different. The model the announcement is about is what they share, so that is what is compared.
 */
function announcementTold(
  db: Database,
  model: string,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): boolean {
  const since = new Date(now - ANNOUNCEMENT_WINDOW_MS).toISOString();
  return db
    .query<Event & { signal: string }, (string | number)[]>(
      `SELECT e.* FROM batch_events be
       JOIN events e ON e.id=be.event_id
       JOIN deliveries d ON d.batch_id=be.batch_id
       WHERE be.batch_id<>? AND d.destination_id=? AND e.detected_at>=? ${asOf ? "AND e.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[batchId, destinationId, since, ...(asOf ? [asOf] : [])])
    .some((row) => announcementModel(row) === model);
}

/**
 * A sighting of something its maker had already announced, to anyone.
 *
 * xAI's release notes put Grok Voice Transcribe 2.0 on the public channel at 06:26 on 2026-09-18;
 * the news page about it appeared in xAI's sitemap twelve hours later and reached the scouts as a
 * sighting. The repeat check is per destination and the scouts had not been told, but a sighting is
 * the earliest word on something, and after the maker's announcement it is the latest. Both events
 * were in one story, so the story says it.
 */
function announcedBeforeSighted(db: Database, event: Event, storyId: number | undefined, batchId: number): boolean {
  if (storyId === undefined || event.kind !== "new") return false;
  return Boolean(
    db
      .query(
        `SELECT 1 FROM story_events previous
         JOIN events earlier ON earlier.id=previous.event_id
         JOIN batch_events be ON be.event_id=earlier.id
         JOIN deliveries d ON d.batch_id=be.batch_id
         WHERE previous.story_id=? AND previous.event_id<>? AND be.batch_id<>? AND earlier.detected_at<=?
           AND be.signal IN ('launch','release','feature')
           AND d.status IN ('sent','sending','ambiguous','verification_required')
         LIMIT 1`,
      )
      .get(storyId, event.id, batchId, event.detected_at),
  );
}

const DEBUT_WINDOW_MS = 24 * 3_600_000;

function repeatsDeliveredStory(
  db: Database,
  event: Event & { signal?: string },
  destinationId: string,
  storyId: number | undefined,
  batchId: number,
  asOf: AsOf = undefined,
): boolean {
  if (storyId === undefined || event.kind !== "new") return false;
  const candidates = db
    .query<
      { source: string; stream: string; detected_at: string; confidence: string; signal: string },
      (number | string)[]
    >(
      `SELECT DISTINCT earlier.source,earlier.stream,earlier.detected_at,earlier.confidence,be.signal
       FROM story_events se
       JOIN story_events previous ON previous.story_id=se.story_id AND previous.event_id<>se.event_id
       JOIN events earlier ON earlier.id=previous.event_id
       JOIN batch_events be ON be.event_id=earlier.id
       JOIN deliveries d ON d.batch_id=be.batch_id
       WHERE se.event_id=? AND be.batch_id<>? AND d.destination_id=? ${asOf ? "AND earlier.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[event.id, batchId, destinationId, ...(asOf ? [asOf] : [])]);
  const detectedAt = Date.parse(event.detected_at);
  // A debut is news about a model the reader was already told arrived: the launch card said it
  // exists, the debut says how good it is. Only another debut of the same model repeats it, from
  // whichever board, so a model entering three boards in a day is one card.
  if (event.signal === "debut")
    return candidates.some(
      (candidate) =>
        candidate.signal === "debut" && Math.abs(detectedAt - Date.parse(candidate.detected_at)) <= DEBUT_WINDOW_MS,
    );
  return candidates.some((candidate) => {
    const earlierAt = Date.parse(candidate.detected_at);
    return (
      Number.isFinite(earlierAt) &&
      Number.isFinite(detectedAt) &&
      Math.abs(detectedAt - earlierAt) <= DUPLICATE_STORY_WINDOW_MS &&
      sourceFamily(candidate.source, candidate.stream) !== sourceFamily(event.source, event.stream) &&
      CONFIDENCE_LEVELS.indexOf(candidate.confidence as NonNullable<Event["confidence"]>) >=
        CONFIDENCE_LEVELS.indexOf(event.confidence ?? "observed")
    );
  });
}

/** How long a model named by a vendor's pages stays the same piece of news for one destination. */
const PAGE_MODEL_WINDOW_MS = 24 * 3_600_000;

/** The models this destination was already told a vendor's pages are naming. */
function pageModelsTold(
  db: Database,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): Set<string> {
  const rows = db
    .query<Event, (string | number)[]>(
      `SELECT DISTINCT e.* FROM delivery_events de
       JOIN deliveries d ON d.id=de.delivery_id
       JOIN events e ON e.id=de.event_id
       WHERE d.destination_id=? AND d.batch_id<>? AND e.stream='pages' AND e.kind='new' AND e.detected_at>=?
         ${asOf ? "AND e.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[destinationId, batchId, new Date(now - PAGE_MODEL_WINDOW_MS).toISOString(), ...(asOf ? [asOf] : [])]);
  return new Set(rows.map(pageModel).filter((model): model is string => model !== null));
}

/** Builds transport payloads without changing immutable event evidence. */
/** How long an immediate batch waits for a sentence that is still being written. */
const SUMMARY_GRACE_MS = 90_000;

/**
 * True while a package release in this batch could still gain a summary and the batch is young
 * enough to wait for it. Only packages wait: a version bump renders to "2.1.268 → 2.1.269" and
 * nothing else, while a large page diff already says something without a sentence. An event that
 * was attempted — recorded in `deepseek_usage` whatever the outcome — is finished waiting, so a
 * provider failure delays a card by one cycle and never strands it.
 */
function awaitingSummary(db: Database, events: readonly Event[], now: number): boolean {
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

type PendingBatch = { id: number; context_json: string | null };
type BatchTarget = { destination_id: string; destination_json: string };

/**
 * Writes one message part for a destination, replacing it only while it is still unsent.
 * `refreshDestination` also rewrites the stored destination, which event and reminder cards do and
 * promotions and recaps, carried as first written, do not.
 */
function upsertDelivery(
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

function sealBatch(db: Database, batchId: number): void {
  db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batchId);
}

function preparePromotion(db: Database, batch: PendingBatch, targets: BatchTarget[], now: number): void {
  const context = promotionContextSchema.parse(JSON.parse(batch.context_json ?? "{}"));
  const original = db
    .query<{ body: string }, [number]>("SELECT body FROM deliveries WHERE id=?")
    .get(context.deliveryId);
  // The card the scouts approved, carried as it was written. Nothing is re-rendered, because a
  // record that has moved since would publish something they never saw.
  if (original)
    for (const target of targets) {
      const destination = JSON.parse(target.destination_json) as Destination;
      if (destination.platform !== "discord") continue;
      const payload = JSON.parse(original.body) as Record<string, unknown>;
      const vouched = `🔎 ${context.votes} readers vouched for this, first seen on the radar`;
      // A promotion never pings: the room already decided, and a role mention would make the
      // public channel louder than the observation deserves.
      const body = JSON.stringify({ ...payload, content: vouched, allowed_mentions: { parse: [] } });
      upsertDelivery(db, batch.id, target, body, 0, now, false);
    }
  sealBatch(db, batch.id);
}

/** The week's arrivals as one picture, the post meant to leave Discord; a quiet week has none. */
function weekPoster(context: RecapContext): Banner | null {
  if (context.period !== "week" || !context.arrivals.length) return null;
  const day = (value: string) =>
    new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const count = context.arrivalCount;
  return {
    filename: `week-${context.to.slice(0, 10)}.png`,
    eyebrow: `${day(context.from)} – ${day(context.to)}`,
    title: `${count} new model${count === 1 ? "" : "s"}`,
    chips: [],
    vendor: context.arrivals[0]?.vendor ?? "",
    logo: null,
    rows: context.arrivals.map((row) => ({
      vendor: row.vendor,
      logo: vendorLogo(row.vendor)?.slice("attachment://".length) ?? null,
      names: row.names,
    })),
  };
}

/**
 * Discord and Telegram read the same cards: a card is stored as Discord writes it and a Telegram
 * message is told from it when it is sent. Plain text is what a platform without cards gets.
 */
const readsCards = (destination: Destination) =>
  destination.platform === "discord" || destination.platform === "telegram";

function prepareRecap(db: Database, batch: PendingBatch, targets: BatchTarget[], now: number): void {
  const context = recapContextSchema.parse(JSON.parse(batch.context_json ?? "{}"));
  for (const target of targets) {
    const destination = JSON.parse(target.destination_json) as Destination;
    const lines = renderRecapLines(context, destination.signals);
    // A day is prices for one room and leaders for the other; a room whose part is empty hears nothing.
    if (!lines.length) continue;
    const embed = renderRecapEmbed(context, destination.signals);
    const poster = weekPoster(context);
    const body = readsCards(destination)
      ? JSON.stringify({
          content: "",
          // The poster says what the author line would; the text below it stays as the week's detail.
          embeds: [
            poster && embed
              ? { ...embed, author: undefined, image: { url: `attachment://${poster.filename}` } }
              : embed,
          ],
          ...(poster ? { banners: [poster] } : {}),
        })
      : lines.join("\n");
    upsertDelivery(db, batch.id, target, body, 0, now, false);
  }
  sealBatch(db, batch.id);
}

function prepareLifecycleReminder(
  db: Database,
  batch: PendingBatch,
  events: Event[],
  targets: BatchTarget[],
  now: number,
): void {
  const event = events[0];
  if (!event || !batch.context_json) {
    sealBatch(db, batch.id);
    return;
  }
  const context = parseLifecycleReminderContext(JSON.parse(batch.context_json));
  for (const target of targets) {
    const destination = JSON.parse(target.destination_json) as Destination;
    if (readsCards(destination)) {
      upsertDelivery(
        db,
        batch.id,
        target,
        JSON.stringify({ content: "", embeds: [renderLifecycleReminderEmbed(context, event)] }),
        0,
        now,
        true,
      );
    } else {
      splitMessage(renderLifecycleReminderText(context, event), 3900).forEach((body, part) => {
        upsertDelivery(db, batch.id, target, body, part, now, true);
      });
    }
  }
  sealBatch(db, batch.id);
}

/** What a batch knows about its events that every destination's judgement reads. */
type BatchView = {
  renamed: Set<number>;
  schema: Set<number>;
  herd: Set<number>;
  longKnown: Set<number>;
  known: ReturnType<typeof knownModelNames>;
  listings: ReturnType<typeof listingsBySubject> | null;
  sighted: (event: Event) => boolean;
  elsewhereOf: (event: Event) => string[];
};

/**
 * Why an event is not worth a card to anyone, whichever destination is asking, or null when nothing
 * about the event itself holds it back. Checks that depend on what a destination has already been
 * told stay with the destination. The order is the order reasons are recorded in: the first that
 * applies is the one a reader sees.
 */
function standingReason(
  db: Database,
  event: Event & { signal: SignalClass | "" },
  view: BatchView,
): SuppressionReason | null {
  if (view.renamed.has(event.id)) return "renamed_by_the_source";
  if (isMinorBoardMove(event)) return "below_the_top_of_the_board";
  if (isAnotherServing(event, view.known)) return "another_serving_of_a_known_model";
  if ((event.signal === "article" || event.signal === "business") && isAboutTheCompanyNotAModel(event, view.known))
    return "a_post_about_the_company_not_a_model";
  if (isLabelOnlyChange(event)) return "display_label_only";
  if (view.schema.has(event.id)) return "a_field_the_source_started_sending";
  if (view.herd.has(event.id)) return "one_change_across_the_whole_list";
  if (view.longKnown.has(event.id)) return "known_here_for_weeks";
  if (isAliasRow(event)) return "alias_of_another_row";
  if (isAnotherTierOfAListedModel(db, event)) return "another_tier_of_a_listed_model";
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
  if (event.signal === "codename" && wasReleasedLongBefore(db, event)) return "released_long_before_this_listing";
  if (event.signal === "codename" && namesOnlyKnownModels(event, view.known)) return "names_only_known_models";
  if (event.signal === "release" && isFixesOnlyRelease(event)) return "fixes_only_release";
  return null;
}

/** Everything the standing judgement reads about a batch, built once and shared by its destinations. */
function batchViewOf(db: Database, events: readonly (Event & { signal: SignalClass | "" })[]): BatchView {
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
  // Read once per batch: the question is about the event, not about the destination.
  const known = events.some(
    (event) => ["arena", "web"].includes(event.stream) || event.signal === "article" || event.signal === "business",
  )
    ? knownModelNames(db)
    : [];
  return { renamed, schema, herd, longKnown, known, listings, sighted, elsewhereOf };
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
  const classed = events.map((event) => ({ ...event, signal: classify(db, event) }));
  const view = batchViewOf(db, classed);
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
  const classed = events.map((event) => ({ ...event, signal: classify(db, event) }));
  const view = batchViewOf(db, classed);
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
      if (!isMakersAnnouncement(event) && retellsToldModels(db, event, destinationId, asOf))
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

/** The server's emoji for each vendor, as uploaded to the Discord guild the roles live in. */
const VENDOR_EMOJIS: Record<string, string> = {
  Anthropic: "<:anthropic:1551934115282944060>",
  OpenAI: "<:openai:1551934248267546665>",
  Google: "<:gemini:1551934399975661688>",
  DeepSeek: "<:deepseek:1551934735742279690>",
  Qwen: "<:qwen:1551935251465379900>",
  xAI: "<:xai:1551939748443062302>",
  "Z.ai": "<:zai:1551939865904549948>",
  Meta: "<:meta:1551939937216110632>",
  Moonshot: "<:kimi:1551940005532803173>",
  Xiaomi: "<:xiaomi:1551940073019285555>",
};

export function prepareDeliveries(
  db: Database,
  now = Date.now(),
  vendorRoles: Record<string, string> = {},
  allSignalsRole?: string,
  seal = true,
): void {
  const batches = db
    .query<
      {
        id: number;
        digest: number;
        source: string;
        kind: "event" | "lifecycle_reminder" | "weekly_recap" | "promotion";
        context_json: string | null;
      },
      [string]
    >("SELECT id,digest,source,kind,context_json FROM batches WHERE sealed=0 AND ready_at<=? ORDER BY id")
    .all(new Date(now).toISOString());
  for (const batch of batches) {
    let hasSpeakingEvents = false;
    const events = db
      .query<Event & { url: string; signal: SignalClass | "" }, [number]>(
        "SELECT e.*,b.signal,COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),b.url) AS url FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
      )
      .all(batch.id);
    // An immediate batch is rendered within seconds of the poll that created it, and the message
    // body is stored at render time. A package release bump carries nothing but a version number
    // until its release notes are fetched and summarised, so rendering it on sight ships the empty
    // version of the card and seals the batch before the sentence can ever arrive. Hourly digests
    // never hit this because they sit unsealed for an hour; every delivered package release did.
    if (batch.kind === "event" && !batch.digest && awaitingSummary(db, events, now)) continue;
    const targets = db
      .query<{ destination_id: string; destination_json: string }, [number]>(
        "SELECT destination_id,destination_json FROM batch_targets WHERE batch_id=? ORDER BY rowid",
      )
      .all(batch.id);
    if (batch.kind === "promotion") {
      preparePromotion(db, batch, targets, now);
      continue;
    }
    if (batch.kind === "weekly_recap") {
      prepareRecap(db, batch, targets, now);
      continue;
    }
    if (batch.kind === "lifecycle_reminder") {
      prepareLifecycleReminder(db, batch, events, targets, now);
      continue;
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
    const { listings, sighted, elsewhereOf } = batchView;
    for (const target of targets) {
      const destination = JSON.parse(target.destination_json) as Destination;
      const subscribed = new Set<string>(destination.signals);
      // Every event subscribed to by this destination leaves either a card or a written reason.
      const quiet = (event: Event, reason: SuppressionReason): never[] => {
        recordSuppression(db, event, target.destination_id, batch.id, reason, now);
        return [];
      };
      const toldPages = events.some((event) => pageModel(event) && subscribed.has(event.signal))
        ? pageModelsTold(db, target.destination_id, batch.id, now)
        : new Set<string>();
      const releases = new Set<string>();
      const speaking = events
        .filter((event) => subscribed.has(event.signal))
        .flatMap((event) => {
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
          if (!isMakersAnnouncement(event) && retellsToldModels(db, event, target.destination_id))
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
      for (const event of speaking) {
        const returned = departedAs(db, event, now);
        if (returned) Object.assign(event, { returned });
        if (isStealthLaunch(event)) {
          const borrowed = borrowedFacts(db, event, stealthSubject(event));
          if (Object.keys(borrowed).length) Object.assign(event, { borrowed });
        }
        if (listings && sighted(event)) {
          const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
          const elsewhere = elsewhereOf(event);
          // An arena entry nobody lists is the ordinary case and its card already says so.
          if (elsewhere.length || event.stream !== "arena") Object.assign(event, { elsewhere });
          if (event.stream === "arena" && record) {
            const siblings = rosterSiblings(db, event.source, event.entity_id, String(record.name ?? ""), record.maker);
            if (siblings.length) Object.assign(event, { siblings });
          }
        }
      }
      if (!speaking.length) {
        db.query(
          "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0",
        ).run(batch.id, target.destination_id);
        continue;
      }
      hasSpeakingEvents = true;
      const grouped = new Map<string, StoryRenderEvent[]>();
      for (const event of speaking) {
        const lead = leads.get(event.id);
        if (lead) Object.assign(event, { lead });
        const key = storyIds.has(event.id) ? `story:${storyIds.get(event.id)}` : `event:${event.id}`;
        const group = grouped.get(key) ?? [];
        group.push(event);
        grouped.set(key, group);
      }
      // Ten embeds is what Discord allows in a message, not what a person reads in one. A digest
      // that arrives as a wall is skipped whole, which loses the two cards in it that mattered.
      const all = [...grouped.values()];
      const items = batch.digest ? all.slice(0, DIGEST_STORIES) : all;
      const withheld = all.length - items.length;
      // A story past the cap is not delivered later either: the digest is sealed with it inside.
      // It keeps a written reason like every other event that did not become a card.
      for (const group of all.slice(items.length))
        for (const event of group)
          recordSuppression(db, event, target.destination_id, batch.id, "past_the_digest_limit", now);
      const source = sourceLabel(batch.source);
      // A digest of one story is a card; calling it a digest is a header spent on nothing.
      const header = batch.digest
        ? all.length > 1
          ? `🗞 Hourly digest · ${all.length} stories${withheld ? ` · showing ${items.length}` : ""}\n\n`
          : ""
        : speaking.length > 1
          ? `📡 ${source} · ${speaking.length} updates\n\n`
          : "";
      const blocks = items.map((group) => {
        if (group.length > 1) return renderStoryText(group, destination.platform, summaries);
        const event = group[0] as StoryRenderEvent;
        const rendered = renderEvent(event, event.url, destination.platform, summaries.get(event.id));
        const lines = rendered.split("\n");
        const heading = lines[0] ?? `Update · ${sourceLabel(event.source)}`;
        const footer = lines.slice(-2).join("\n");
        const content = lines.slice(1, -2).join("\n").trim();
        const compact = content.length > 800 ? `${clip(content, 800)}…` : content;
        return [heading, compact, footer].filter(Boolean).join("\n");
      });
      const text = blocks.join(SEPARATOR);
      const store = (payload: string, part: number, carried: StoryRenderEvent[] = []) => {
        upsertDelivery(db, batch.id, target, payload, part, now, true);
        // Which message carried which event, recorded where it is known exactly rather than
        // inferred later from batch membership, which is wrong as soon as a batch pages.
        const delivery = db
          .query<{ id: number }, [number, string, number]>(
            "SELECT id FROM deliveries WHERE batch_id=? AND destination_id=? AND part=?",
          )
          .get(batch.id, target.destination_id, part);
        if (!delivery) return;
        // A re-render may move an event to another page or drop it; the links describe this render,
        // so an unsent part forgets what an earlier render put on it.
        db.query(
          "DELETE FROM delivery_events WHERE delivery_id IN (SELECT id FROM deliveries WHERE id=? AND status='pending' AND attempts=0)",
        ).run(delivery.id);
        for (const event of carried)
          db.query("INSERT OR IGNORE INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(
            delivery.id,
            event.id,
          );
      };

      if (readsCards(destination)) {
        const pinged = batch.digest ? [] : speaking.filter(pingWorthy);
        const vendors = [
          ...new Set(
            pinged.map((event) => {
              const record = event.after_json
                ? (JSON.parse(event.after_json) as RecordData)
                : event.before_json
                  ? (JSON.parse(event.before_json) as RecordData)
                  : null;
              return vendorOf(event, record);
            }),
          ),
        ];
        const roles = [
          // A reader who follows everything is mentioned beside the vendor roles, never instead
          // of them, and never for routine movement.
          ...(pinged.length && allSignalsRole ? [allSignalsRole] : []),
          ...new Set(vendors.map((vendor) => vendorRoles[vendor]).filter((role): role is string => Boolean(role))),
        ];
        const mentions = roles.map((role) => `<@&${role}>`).join(" ");
        // A small company's model that took off says why it is a card now and was a recap line before.
        const tookOff = speaking.flatMap((event) => {
          const breakout = breakoutOf(db, event.id);
          if (breakout) return [breakoutLine(event, breakout)];
          // A card nobody's rule asked for, sent because the sources had piled up unread.
          const corroboration = corroborationOfEvent(db, event.id);
          return corroboration ? [corroborationLine(corroboration)] : [];
        });
        const roster = !batch.digest && items.every((group) => group.length === 1) && isRoster(items.flat());
        const rendered = roster
          ? [rosterEmbed(items.flat(), destination.detail)]
          : items.map((group) =>
              group.length > 1
                ? storyEmbed(group, summaries, destination.detail)
                : eventEmbed(
                    group[0] as StoryRenderEvent,
                    (group[0] as StoryRenderEvent).url,
                    summaries.get((group[0] as StoryRenderEvent).id),
                    destination.detail,
                  ),
            );
        const embeds = distinctLinks(rendered);
        // On Discord the ping reads as a headline: "@Xiaomi · [logo] New Xiaomi models", the way the
        // role menu names the vendor. Telegram drops the mention and has no server emoji to show.
        const title = String(embeds[0]?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
        const emoji = vendors.map((vendor) => VENDOR_EMOJIS[vendor]).find(Boolean);
        const pingLine =
          destination.platform === "discord" && mentions && title
            ? `${mentions} · ${emoji ? `${emoji} ` : ""}${title}`
            : mentions;
        // An embed and its evidence file travel together: the page an embed lands on decides
        // which message carries its attachment.
        const attachments = new Map<Record<string, unknown>, Attachment>();
        const behind = new Map<Record<string, unknown>, StoryRenderEvent[]>();
        if (roster) behind.set(embeds[0] as Record<string, unknown>, items.flat());
        else
          items.forEach((group, index) => {
            const file = group.length === 1 ? eventAttachment(group[0] as StoryRenderEvent) : null;
            const embed = embeds[index];
            if (!embed) return;
            if (file) attachments.set(embed, file);
            behind.set(embed, group);
          });
        // Telegram counts a message's characters to 4096; the markup and the footer lines take the rest.
        const { page, extra } = oneMessage(
          embeds,
          destination.platform === "telegram" ? 3200 : undefined,
          batch.digest ? DIGEST_EMBEDS : 1,
        );
        // What did not fit is told on one line of links rather than in a second message: the
        // events behind it are carried by this message, so none of them is sent again later.
        const alsoLine = extra.length
          ? `-# Also: ${extra
              .map((embed) => {
                const name = String(embed.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
                const link = typeof embed.url === "string" ? embed.url.split("#")[0] : null;
                return link ? `[${name}](${link})` : name;
              })
              .filter(Boolean)
              .join(" · ")}`
          : "";
        // A roster card names its own count and catalogue; the "3 updates" line above it would repeat it.
        const content = [roster ? "" : header.trim(), ...tookOff, pingLine, alsoLine].filter(Boolean).join("\n");
        const files = page.map((embed) => attachments.get(embed)).filter((file): file is Attachment => Boolean(file));
        const carried = [...page, ...extra].flatMap((embed) => behind.get(embed) ?? []);
        // A message that continues one story hangs off the one that told it first, so the reveal of
        // a codename carries a jump back to the sighting rather than repeating it.
        const replyTo = firstTelling(db, carried, storyIds, target.destination_id);
        // A banner's words travel beside the embeds, and its picture is drawn when the message is sent.
        const banners = page.flatMap((embed) => (embed.banner ? [embed.banner] : []));
        store(
          JSON.stringify({
            content,
            embeds: page.map(({ banner: _banner, ...embed }) => embed),
            ...(banners.length ? { banners } : {}),
            ...(files.length ? { files } : {}),
            ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
            ...(roles.length ? { allowed_mentions: { parse: [], roles } } : {}),
          }),
          0,
          carried,
        );
        db.query(
          "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0 AND part>=1",
        ).run(batch.id, target.destination_id);
        continue;
      }
      const parts = splitMessage(text, 3900 - header.length);
      // A story is carried by every part its text reaches: a long one split across two messages
      // was told by both. Parts are located by walking them through the text they were cut from.
      const spans: [number, number][] = [];
      let cursor = 0;
      for (const body of parts) {
        cursor = text.indexOf(body, cursor);
        spans.push([cursor, cursor + body.length]);
        cursor += body.length;
      }
      let offset = 0;
      const told = parts.map((): StoryRenderEvent[] => []);
      blocks.forEach((block, index) => {
        const end = offset + block.length;
        spans.forEach(([start, stop], part) => {
          if (start < end && offset < stop) told[part]?.push(...(items[index] ?? []));
        });
        offset = end + SEPARATOR.length;
      });
      parts.forEach((body, part) => {
        store(header + body, part, told[part]);
      });
      db.query(
        "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0 AND part>=?",
      ).run(batch.id, target.destination_id, parts.length);
    }
    if (seal || !hasSpeakingEvents) sealBatch(db, batch.id);
  }
}

/**
 * Discord folds embeds of one message that share a link into the first of them, so three cards that
 * all pointed at one catalogue page showed as one. A fragment keeps each link going to the same page
 * while making it the card's own.
 */
function distinctLinks(embeds: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Map<string, number>();
  return embeds.map((embed) => {
    if (typeof embed.url !== "string") return embed;
    const count = seen.get(embed.url) ?? 0;
    seen.set(embed.url, count + 1);
    if (count === 0) return embed;
    const [base] = embed.url.split("#");
    return { ...embed, url: `${base}#${count + 1}` };
  });
}
