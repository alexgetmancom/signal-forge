import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { sourceLabel } from "../sources/labels.js";
import { splitMessage } from "./canonical.js";
import { pingWorthy, vendorOf } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { eventEmbed } from "./render/discord.js";
import {
  parseLifecycleReminderContext,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
} from "./render/lifecycle.js";
import { renderStoryText, type StoryRenderEvent, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import type { Event, RecordData } from "./types.js";

/** Turns sealed observation batches into transport payloads without changing event evidence. */
export function prepareDeliveries(db: Database, now = Date.now(), vendorRoles: Record<string, string> = {}): void {
  const batches = db
    .query<
      { id: number; digest: number; source: string; kind: "event" | "lifecycle_reminder"; context_json: string | null },
      [number]
    >("SELECT id,digest,source,kind,context_json FROM batches WHERE sealed=0 AND ready_at<=? ORDER BY id")
    .all(now);
  for (const batch of batches) {
    const events = db
      .query<Event & { url: string }, [number]>(
        "SELECT e.*,b.url FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
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
            "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)",
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
              "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)",
            ).run(batch.id, target.destination_id, target.destination_json, body, part, now);
          });
        }
      }
      db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
      continue;
    }
    const speaking = events.filter((event) => {
      return hasNotificationContent(event, event.url);
    });
    if (!speaking.length) {
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
    const grouped = new Map<string, StoryRenderEvent[]>();
    for (const event of speaking) {
      const key = storyIds.has(event.id) ? `story:${storyIds.get(event.id)}` : `event:${event.id}`;
      const group = grouped.get(key) ?? [];
      group.push(event);
      grouped.set(key, group);
    }
    const items = [...grouped.values()];
    for (const target of targets) {
      const destination = JSON.parse(target.destination_json) as Destination;
      const source = sourceLabel(batch.source);
      const header = batch.digest
        ? `🗞 ${source} · ${items.length} ${items.length === 1 ? "story" : "stories"} in the last hour\n\n`
        : speaking.length > 1
          ? `📡 ${source} · ${speaking.length} updates\n\n`
          : "";
      const text = items
        .map((group) => {
          if (group.length > 1) return renderStoryText(group, destination.platform, summaries);
          const event = group[0] as StoryRenderEvent;
          const rendered = renderEvent(event, event.url, destination.platform, summaries.get(event.id));
          const lines = rendered.split("\n");
          const footer = lines.slice(-2).join("\n");
          const content = lines.slice(1, -2).join("\n").trim();
          const kind = { new: "🆕", changed: "✏️", removed: "🗑️" }[event.kind];
          return `${kind} ${content.length > 800 ? `${content.slice(0, 800)}…` : content}\n${footer}`;
        })
        .join("\n\n────────\n\n");
      const store = (payload: string, part: number) =>
        db
          .query(
            "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(batch.id, target.destination_id, target.destination_json, payload, part, now);

      if (destination.platform === "discord") {
        const roles = batch.digest
          ? []
          : [
              ...new Set(
                events
                  .filter(pingWorthy)
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
        for (let index = 0; index * 10 < embeds.length; index += 1) {
          const page = embeds.slice(index * 10, index * 10 + 10);
          const content = index === 0 ? [header.trim(), mentions].filter(Boolean).join("\n") : "";
          store(
            JSON.stringify({
              content,
              embeds: page,
              ...(index === 0 && roles.length ? { allowed_mentions: { parse: [], roles } } : {}),
            }),
            index,
          );
        }
        continue;
      }
      splitMessage(text, 3900 - header.length).forEach((body, part) => {
        store(header + body, part);
      });
    }
    db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
  }
}
