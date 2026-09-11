import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { sourceLabel } from "../sources/labels.js";
import { splitMessage } from "./canonical.js";
import { CONFIDENCE_LEVELS } from "./confidence.js";
import { deliveryBaseline, withBaseline } from "./cooldown.js";
import { vendorOf } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { isOscillating, isScheduledPricingRotation } from "./oscillation.js";
import { type Attachment, eventAttachment } from "./render/attachment.js";
import { pageEmbeds } from "./render/budget.js";
import { eventEmbed } from "./render/discord.js";
import {
  parseLifecycleReminderContext,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
} from "./render/lifecycle.js";
import { renderStoryText, type StoryRenderEvent, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import { pingWorthy, type SignalClass } from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import type { Event, RecordData } from "./types.js";

const DUPLICATE_STORY_WINDOW_MS = 6 * 3_600_000;

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

/** Builds transport payloads without changing immutable event evidence. */
export function prepareDeliveries(
  db: Database,
  now = Date.now(),
  vendorRoles: Record<string, string> = {},
  allSignalsRole?: string,
  seal = true,
): void {
  const batches = db
    .query<
      { id: number; digest: number; source: string; kind: "event" | "lifecycle_reminder"; context_json: string | null },
      [number]
    >("SELECT id,digest,source,kind,context_json FROM batches WHERE sealed=0 AND ready_at<=? ORDER BY id")
    .all(now);
  for (const batch of batches) {
    let hasSpeakingEvents = false;
    const events = db
      .query<Event & { url: string; signal: SignalClass | "" }, [number]>(
        "SELECT e.*,b.signal,COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),b.url) AS url FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
      )
      .all(batch.id);
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
            now,
          );
        } else {
          splitMessage(renderLifecycleReminderText(context, event), 3900).forEach((body, part) => {
            db.query(
              `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET destination_json=excluded.destination_json,body=excluded.body,updated_at=excluded.updated_at
               WHERE deliveries.status='pending' AND deliveries.attempts=0`,
            ).run(batch.id, target.destination_id, target.destination_json, body, part, now);
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
    for (const target of targets) {
      const destination = JSON.parse(target.destination_json) as Destination;
      const subscribed = new Set<string>(destination.signals);
      const speaking = events
        .filter(
          (event) =>
            subscribed.has(event.signal) &&
            hasNotificationContent(event) &&
            !isScheduledPricingRotation(event) &&
            !isOscillating(db, event, now) &&
            !repeatsDeliveredStory(db, event, target.destination_id, storyIds.get(event.id), batch.id),
        )
        .flatMap((event) => {
          // A number that keeps moving waits, then speaks once about the whole move this
          // destination missed. Only routine drift waits: an event the policy already decided is
          // worth interrupting a reader for, such as a benchmark changing hands at the top, is
          // news every time it happens.
          if (!batch.digest || event.signal !== "change" || event.kind !== "changed") return [event];
          const baseline = deliveryBaseline(db, event, target.destination_id, batch.id, now);
          if (baseline.hold) return [];
          const caughtUp = { ...event, ...withBaseline(event, baseline) };
          // A move that returns exactly to the state a destination last saw has nothing to say.
          return hasNotificationContent(caughtUp) ? [caughtUp] : [];
        });
      if (!speaking.length) {
        db.query(
          "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0",
        ).run(batch.id, target.destination_id);
        continue;
      }
      hasSpeakingEvents = true;
      const grouped = new Map<string, StoryRenderEvent[]>();
      for (const event of speaking) {
        const key = storyIds.has(event.id) ? `story:${storyIds.get(event.id)}` : `event:${event.id}`;
        const group = grouped.get(key) ?? [];
        group.push(event);
        grouped.set(key, group);
      }
      const items = [...grouped.values()];
      const source = sourceLabel(batch.source);
      const header = batch.digest
        ? `🗞 Hourly digest · ${items.length} ${items.length === 1 ? "story" : "stories"}\n\n`
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
      const store = (payload: string, part: number) =>
        db
          .query(
            `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)
             ON CONFLICT(batch_id,destination_id,part) DO UPDATE SET destination_json=excluded.destination_json,body=excluded.body,updated_at=excluded.updated_at
             WHERE deliveries.status='pending' AND deliveries.attempts=0`,
          )
          .run(batch.id, target.destination_id, target.destination_json, payload, part, now);

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
        items.forEach((group, index) => {
          const file = group.length === 1 ? eventAttachment(group[0] as StoryRenderEvent) : null;
          const embed = embeds[index];
          if (file && embed) attachments.set(embed, file);
        });
        const pages = pageEmbeds(embeds);
        pages.forEach((page, index) => {
          const content = index === 0 ? [header.trim(), mentions].filter(Boolean).join("\n") : "";
          const files = page.map((embed) => attachments.get(embed)).filter((file): file is Attachment => Boolean(file));
          store(
            JSON.stringify({
              content,
              embeds: page,
              ...(files.length ? { files } : {}),
              ...(index === 0 && roles.length ? { allowed_mentions: { parse: [], roles } } : {}),
            }),
            index,
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
