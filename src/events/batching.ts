import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { promotionContextSchema } from "../promotion.js";
import { recapContextSchema } from "../recap.js";
import { sourceLabel } from "../sources/labels.js";
import { splitMessage } from "./canonical.js";
import { CONFIDENCE_LEVELS } from "./confidence.js";
import { deliveryBaseline, withBaseline } from "./cooldown.js";
import { vendorOf } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { departedAs, isOscillating, isReappearance, isScheduledPricingRotation } from "./oscillation.js";
import { renamedEvents } from "./rename.js";
import { type Attachment, eventAttachment } from "./render/attachment.js";
import { pageEmbeds } from "./render/budget.js";
import { eventEmbed } from "./render/discord.js";
import type { LeadTime } from "./render/facts.js";
import {
  parseLifecycleReminderContext,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
  renderRecapEmbed,
  renderRecapLines,
} from "./render/lifecycle.js";
import { renderStoryText, type StoryRenderEvent, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import { listsAnotherMakersModel, pingWorthy, type SignalClass } from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import { clearSuppression, recordSuppression, type SuppressionReason } from "./suppression.js";
import type { Event, RecordData } from "./types.js";
import { displayName } from "./variants.js";
import { listingsBySubject, subjectKey } from "./witness.js";
import {
  isAboutTheCompanyNotAModel,
  isAliasRow,
  isAnotherServing,
  isAnotherTierOfAListedModel,
  isLabelOnlyChange,
  isMinorBoardMove,
  isPublishedByAFollowedLab,
  knownModelNames,
  pageModel,
} from "./worth.js";

const DUPLICATE_STORY_WINDOW_MS = 6 * 3_600_000;
/** How many stories an hourly digest shows before it stops being read at all. */
const DIGEST_STORIES = 5;

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

function repeatsDeliveredStory(
  db: Database,
  event: Event,
  destinationId: string,
  storyId: number | undefined,
  batchId: number,
): boolean {
  if (storyId === undefined || event.kind !== "new") return false;
  const candidates = db
    .query<{ source: string; stream: string; detected_at: string; confidence: string }, [number, number, string]>(
      `SELECT DISTINCT earlier.source,earlier.stream,earlier.detected_at,earlier.confidence
       FROM story_events se
       JOIN story_events previous ON previous.story_id=se.story_id AND previous.event_id<>se.event_id
       JOIN events earlier ON earlier.id=previous.event_id
       JOIN batch_events be ON be.event_id=earlier.id
       JOIN deliveries d ON d.batch_id=be.batch_id
       WHERE se.event_id=? AND be.batch_id<>? AND d.destination_id=?
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(event.id, batchId, destinationId);
  const detectedAt = Date.parse(event.detected_at);
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
function pageModelsTold(db: Database, destinationId: string, batchId: number, now: number): Set<string> {
  const rows = db
    .query<Event, [string, number, string]>(
      `SELECT DISTINCT e.* FROM delivery_events de
       JOIN deliveries d ON d.id=de.delivery_id
       JOIN events e ON e.id=de.event_id
       WHERE d.destination_id=? AND d.batch_id<>? AND e.stream='pages' AND e.kind='new' AND e.detected_at>=?
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(destinationId, batchId, new Date(now - PAGE_MODEL_WINDOW_MS).toISOString());
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
    const summaries = new Map(
      db
        .query<{ event_id: number; text: string }, []>("SELECT event_id,text FROM summaries")
        .all()
        .map((row) => [row.event_id, row.text] as const),
    );
    const targets = db
      .query<{ destination_id: string; destination_json: string }, [number]>(
        "SELECT destination_id,destination_json FROM batch_targets WHERE batch_id=? ORDER BY rowid",
      )
      .all(batch.id);
    if (batch.kind === "promotion") {
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
          const vouched =
            context.reason === "owner"
              ? "🔎 Vouched for by the tracker's owner, first seen by the scouts"
              : `🔎 ${context.votes} scouts vouched for this, first seen in the invited room`;
          db.query(
            `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,0,?)
             ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at
             WHERE deliveries.status='pending' AND deliveries.attempts=0`,
          ).run(
            batch.id,
            target.destination_id,
            target.destination_json,
            // A promotion never pings: the room already decided, and a role mention would make the
            // public channel louder than the observation deserves.
            JSON.stringify({ ...payload, content: vouched, allowed_mentions: { parse: [] } }),
            new Date(now).toISOString(),
          );
          hasSpeakingEvents = true;
        }
      db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
      continue;
    }
    if (batch.kind === "weekly_recap") {
      const context = recapContextSchema.parse(JSON.parse(batch.context_json ?? "{}"));
      for (const target of targets) {
        const destination = JSON.parse(target.destination_json) as Destination;
        const body =
          destination.platform === "discord"
            ? JSON.stringify({ content: "", embeds: [renderRecapEmbed(context)] })
            : renderRecapLines(context).join("\n");
        db.query(
          `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,0,?)
           ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at
           WHERE deliveries.status='pending' AND deliveries.attempts=0`,
        ).run(batch.id, target.destination_id, target.destination_json, body, new Date(now).toISOString());
      }
      db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
      hasSpeakingEvents = true;
      continue;
    }
    if (batch.kind === "lifecycle_reminder") {
      const event = events[0];
      if (!event || !batch.context_json) {
        db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
        continue;
      }
      const context = parseLifecycleReminderContext(JSON.parse(batch.context_json));
      for (const target of targets) {
        const destination = JSON.parse(target.destination_json) as Destination;
        if (destination.platform === "discord") {
          db.query(
            `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
             ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET destination_json=excluded.destination_json,body=excluded.body,updated_at=excluded.updated_at
             WHERE deliveries.status='pending' AND deliveries.attempts=0`,
          ).run(
            batch.id,
            target.destination_id,
            target.destination_json,
            JSON.stringify({ content: "", embeds: [renderLifecycleReminderEmbed(context, event)] }),
            0,
            new Date(now).toISOString(),
          );
        } else {
          splitMessage(renderLifecycleReminderText(context, event), 3900).forEach((body, part) => {
            db.query(
              `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET destination_json=excluded.destination_json,body=excluded.body,updated_at=excluded.updated_at
               WHERE deliveries.status='pending' AND deliveries.attempts=0`,
            ).run(batch.id, target.destination_id, target.destination_json, body, part, new Date(now).toISOString());
          });
        }
      }
      db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
      continue;
    }
    const storyIds = new Map(
      db
        .query<{ event_id: number; story_id: number }, [number]>(
          "SELECT se.event_id,se.story_id FROM story_events se JOIN batch_events be ON be.event_id=se.event_id WHERE be.batch_id=?",
        )
        .all(batch.id)
        .map((row) => [row.event_id, row.story_id] as const),
    );
    const leads = leadTimes(db, storyIds, events);
    // A re-keyed catalogue speaks once per row, twice: the row that left and the identical row that
    // arrived. Found once per batch, because the answer does not depend on the destination.
    const renamed = renamedEvents(db, events);
    // A sighting from a platform or a registry says where else the model already is; read once
    // per batch, and only when a card will need it.
    const sighted = (event: Event) =>
      event.kind === "new" &&
      (listsAnotherMakersModel(event) || event.source.startsWith("discovery:huggingface") || event.stream === "arena");
    const listings = events.some(sighted) ? listingsBySubject(db) : null;
    // Read once per batch: the question is about the event, not about the destination.
    const known = events.some((event) => event.stream === "arena" || event.signal === "article")
      ? knownModelNames(db)
      : [];
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
      const speaking = events
        .filter((event) => subscribed.has(event.signal))
        .flatMap((event) => {
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
          if (renamed.has(event.id)) return quiet(event, "renamed_by_the_source");
          if (isMinorBoardMove(event)) return quiet(event, "below_the_top_of_the_board");
          if (isAnotherServing(event, known)) return quiet(event, "another_serving_of_a_known_model");
          if (event.signal === "article" && isAboutTheCompanyNotAModel(event, known))
            return quiet(event, "a_post_about_the_company_not_a_model");
          if (isLabelOnlyChange(event)) return quiet(event, "display_label_only");
          if (isAliasRow(event)) return quiet(event, "alias_of_another_row");
          if (isAnotherTierOfAListedModel(db, event)) return quiet(event, "another_tier_of_a_listed_model");
          if (isPublishedByAFollowedLab(db, event)) return quiet(event, "published_by_a_followed_lab");
          if (isScheduledPricingRotation(event)) return quiet(event, "scheduled_pricing_rotation");
          if (isOscillating(db, event, now)) return quiet(event, "oscillating");
          if (isReappearance(db, event, now)) return quiet(event, "flapping_in_and_out");
          if (repeatsDeliveredStory(db, event, target.destination_id, storyIds.get(event.id), batch.id))
            return quiet(event, "already_told_by_another_source");
          // A number that keeps moving waits, then speaks once about the whole move it missed.
          if (baseline?.hold) return quiet(event, "waiting_for_the_move_to_settle");
          const model = pageModel(event);
          if (model && toldPages.has(model)) return quiet(event, "another_page_about_the_same_model");
          if (model) toldPages.add(model);
          return [caughtUp];
        });
      for (const event of speaking) clearSuppression(db, event.id, target.destination_id);
      for (const event of speaking) {
        const returned = departedAs(db, event, now);
        if (returned) Object.assign(event, { returned });
        if (listings && sighted(event)) {
          const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
          const name = displayName(String(record?.name ?? event.entity_id));
          const keys = new Set([subjectKey(event.entity_id), subjectKey(name)]);
          const elsewhere = [...new Set([...keys].flatMap((key) => [...(listings.get(key) ?? [])]))]
            .filter((source) => source !== event.source)
            .sort();
          // An arena entry nobody lists is the ordinary case and its card already says so.
          if (elsewhere.length || event.stream !== "arena") Object.assign(event, { elsewhere });
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
      const source = sourceLabel(batch.source);
      // A digest of one story is a card; calling it a digest is a header spent on nothing.
      const header = batch.digest
        ? all.length > 1
          ? `🗞 Hourly digest · ${all.length} stories${withheld ? ` · showing ${items.length}` : ""}\n\n`
          : ""
        : speaking.length > 1
          ? `📡 ${source} · ${speaking.length} updates\n\n`
          : "";
      const text = items
        .map((group) => {
          if (group.length > 1) return renderStoryText(group, destination.platform, summaries);
          const event = group[0] as StoryRenderEvent;
          const rendered = renderEvent(event, event.url, destination.platform, summaries.get(event.id));
          const lines = rendered.split("\n");
          const heading = lines[0] ?? `Update · ${sourceLabel(event.source)}`;
          const footer = lines.slice(-2).join("\n");
          const content = lines.slice(1, -2).join("\n").trim();
          const compact = content.length > 800 ? `${content.slice(0, 800)}…` : content;
          return [heading, compact, footer].filter(Boolean).join("\n");
        })
        .join("\n\n────────\n\n");
      const store = (payload: string, part: number, carried: StoryRenderEvent[] = []) => {
        db.query(
          `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
             ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET destination_json=excluded.destination_json,body=excluded.body,updated_at=excluded.updated_at
             WHERE deliveries.status='pending' AND deliveries.attempts=0`,
        ).run(batch.id, target.destination_id, target.destination_json, payload, part, new Date(now).toISOString());
        // Which message carried which event, recorded where it is known exactly rather than
        // inferred later from batch membership, which is wrong as soon as a batch pages.
        const delivery = db
          .query<{ id: number }, [number, string, number]>(
            "SELECT id FROM deliveries WHERE batch_id=? AND destination_id=? AND part=?",
          )
          .get(batch.id, target.destination_id, part);
        if (!delivery) return;
        for (const event of carried)
          db.query("INSERT OR IGNORE INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(
            delivery.id,
            event.id,
          );
      };

      if (destination.platform === "discord") {
        const pinged = batch.digest ? [] : speaking.filter(pingWorthy);
        const roles = [
          // A reader who follows everything is mentioned beside the vendor roles, never instead
          // of them, and never for routine movement.
          ...(pinged.length && allSignalsRole ? [allSignalsRole] : []),
          ...new Set(
            pinged
              .map((event) => {
                const record = event.after_json
                  ? (JSON.parse(event.after_json) as RecordData)
                  : event.before_json
                    ? (JSON.parse(event.before_json) as RecordData)
                    : null;
                return vendorOf(event, record);
              })
              .map((vendor) => vendorRoles[vendor])
              .filter((role): role is string => Boolean(role)),
          ),
        ];
        const mentions = roles.map((role) => `<@&${role}>`).join(" ");
        const embeds = items.map((group) =>
          group.length > 1
            ? storyEmbed(group, summaries)
            : eventEmbed(
                group[0] as StoryRenderEvent,
                (group[0] as StoryRenderEvent).url,
                summaries.get((group[0] as StoryRenderEvent).id),
              ),
        );
        // An embed and its evidence file travel together: the page an embed lands on decides
        // which message carries its attachment.
        const attachments = new Map<Record<string, unknown>, Attachment>();
        const behind = new Map<Record<string, unknown>, StoryRenderEvent[]>();
        items.forEach((group, index) => {
          const file = group.length === 1 ? eventAttachment(group[0] as StoryRenderEvent) : null;
          const embed = embeds[index];
          if (!embed) return;
          if (file) attachments.set(embed, file);
          behind.set(embed, group);
        });
        const pages = pageEmbeds(embeds);
        pages.forEach((page, index) => {
          const content = index === 0 ? [header.trim(), mentions].filter(Boolean).join("\n") : "";
          const files = page.map((embed) => attachments.get(embed)).filter((file): file is Attachment => Boolean(file));
          const carried = page.flatMap((embed) => behind.get(embed) ?? []);
          // A page that continues one story hangs off the message that told it first, so the
          // reveal of a codename carries a jump back to the sighting rather than repeating it.
          const replyTo = index === 0 ? firstTelling(db, carried, storyIds, target.destination_id) : null;
          store(
            JSON.stringify({
              content,
              embeds: page,
              ...(files.length ? { files } : {}),
              ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
              ...(index === 0 && roles.length ? { allowed_mentions: { parse: [], roles } } : {}),
            }),
            index,
            carried,
          );
        });
        db.query(
          "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0 AND part>=?",
        ).run(batch.id, target.destination_id, pages.length);
        continue;
      }
      const parts = splitMessage(text, 3900 - header.length);
      parts.forEach((body, part) => {
        store(header + body, part);
      });
      db.query(
        "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0 AND part>=?",
      ).run(batch.id, target.destination_id, parts.length);
    }
    if (seal || !hasSpeakingEvents) db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
  }
}
