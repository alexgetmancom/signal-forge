/**
 * The batches that are not a card about an event: a promotion the room voted for, the recap, a
 * lifecycle reminder.
 *
 * Each is written from a context stored on the batch rather than from event evidence, and each is
 * carried to its destinations as first written -- the difference that matters, because an event card
 * rewrites its stored destination and these do not. Moved out of batching.ts unchanged.
 */

import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { promotionContextSchema } from "../promotion.js";
import { type RecapContext, recapContextSchema } from "../recap.js";
import type { BatchTarget, PendingBatch } from "./batchParts.js";
import { linkDelivery, sealBatch, upsertDelivery } from "./batchParts.js";
import { splitMessage } from "./canonical.js";
import type { Banner } from "./render/banner.js";
import {
  parseLifecycleReminderContext,
  renderLifecycleReminderEmbed,
  renderLifecycleReminderText,
  renderRecapEmbed,
  renderRecapLines,
} from "./render/lifecycle.js";
import { vendorLogo } from "./render/logos.js";
import type { Event } from "./types.js";

export function preparePromotion(db: Database, batch: PendingBatch, targets: BatchTarget[], now: number): void {
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
export const readsCards = (destination: Destination) =>
  destination.platform === "discord" || destination.platform === "telegram";

export function prepareRecap(db: Database, batch: PendingBatch, targets: BatchTarget[], now: number): void {
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

export function prepareLifecycleReminder(
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
    // A reminder is about one deadline, which is one event; unlike a recap it has an exact subject,
    // and it was the one card path that never said so.
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
      linkDelivery(db, batch.id, target.destination_id, 0, [event.id]);
    } else {
      splitMessage(renderLifecycleReminderText(context, event), 3900).forEach((body, part) => {
        upsertDelivery(db, batch.id, target, body, part, now, true);
        linkDelivery(db, batch.id, target.destination_id, part, [event.id]);
      });
    }
  }
  sealBatch(db, batch.id);
}
