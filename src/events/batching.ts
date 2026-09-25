import type { Database } from "bun:sqlite";
import type { Destination } from "../config.js";
import { sourceLabel } from "../sources/labels.js";
import { clip } from "../text.js";
import { linkDelivery, sealBatch, upsertDelivery } from "./batchParts.js";
import { breakoutLine, breakoutOf } from "./breakouts.js";
import { splitMessage } from "./canonical.js";
import { classify } from "./classify.js";
import { deliveryBaseline, withBaseline } from "./cooldown.js";
import { corroborationLine, corroborationOfEvent } from "./corroboration.js";
import { prepareLifecycleReminder, preparePromotion, prepareRecap, readsCards } from "./digests.js";
import { vendorOf } from "./interpretation.js";
import { hasNotificationContent } from "./notification.js";
import { departedAs, isOscillating, isReappearance } from "./oscillation.js";
import type { Attachment } from "./render/attachment.js";
import { eventAttachment } from "./render/attachment.js";
import { oneMessage } from "./render/budget.js";
import { eventEmbed, isRoster, rosterEmbed } from "./render/discord.js";
import type { LeadTime } from "./render/facts.js";
import type { StoryRenderEvent } from "./render/story.js";
import { renderStoryText, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import type { SignalClass } from "./signals.js";
import { isMakersAnnouncement, pingWorthy, stealthSubject } from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import { awaitingJudgement, awaitingSummary, batchViewOf, standingReason } from "./standing.js";
import type { SuppressionReason } from "./suppression.js";
import { clearSuppression, recordSuppression } from "./suppression.js";
import {
  announcedBeforeSighted,
  announcementModel,
  announcementTold,
  firstTelling,
  pageModelsTold,
  releaseKey,
  releaseTold,
  repeatsDeliveredStory,
} from "./toldBefore.js";
import type { Event, RecordData } from "./types.js";
import { rosterSiblings } from "./witness.js";
import { borrowedFacts, pageModel, retellsToldModels } from "./worth.js";

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
    // And the same wait for a judgement, which decides whether a vendor's post speaks at all.
    if (batch.kind === "event" && !batch.digest && awaitingJudgement(db, events, now)) continue;
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
        // Every launch, not only a stealth one: Anthropic's own row for Claude Opus 5.5 carried
        // neither a context length nor a price, and the card went out with the bottom of its
        // picture empty while OpenRouter had both.
        if (event.signal === "launch") {
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
        linkDelivery(
          db,
          batch.id,
          target.destination_id,
          part,
          carried.map((event) => event.id),
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
