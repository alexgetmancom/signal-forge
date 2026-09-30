import { sourceLabel } from "../sources/labels.js";
import { clip } from "../text.js";
import { linkDelivery, upsertDelivery } from "./batchParts.js";
import type { BatchEvent, Delivering } from "./batchPolicy.js";
import { boardInterest, boardPlace, isTellableDebut } from "./boardSignals.js";
import { breakoutLine, breakoutOf } from "./breakouts.js";
import { splitMessage } from "./canonical.js";
import { corroborationLine, corroborationOfEvent } from "./corroboration.js";
import { vendorOf } from "./interpretation.js";
import { recordFor } from "./record.js";
import type { Attachment } from "./render/attachment.js";
import { eventAttachment } from "./render/attachment.js";
import { oneMessage } from "./render/budget.js";
import { eventEmbed, isRoster, rosterEmbed } from "./render/discord.js";
import type { StoryRenderEvent } from "./render/story.js";
import { renderStoryText, storyEmbed } from "./render/story.js";
import { renderEvent } from "./render/telegram.js";
import { pingWorthy } from "./signals.js";
import { recordSuppression } from "./suppression.js";
import { firstTelling } from "./toldBefore.js";
import type { RecordData } from "./types.js";

/** How many stories an hourly digest shows before it stops being read at all. */
const DIGEST_STORIES = 5;
/** A digest tells separate stories, so it may show a few cards; anything else shows one. */
const DIGEST_EMBEDS = 3;
const SEPARATOR = "\n\n────────\n\n";

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

/**
 * Two boards, one arrival, one card.
 *
 * A story's events become one `storyEmbed`, which carries no picture, because a thread of several
 * different things has no single number to put on one. A model debuting on two boards in the same
 * collection is not that: it is one arrival seen twice, and the card a reader wants is the card the
 * better place would have produced on its own. Gemini 4 Argon entered Arena Text at #1 and Arena
 * Code at #8 in the same reading on 2026-09-30, and the choice was a picture of #1 with the other
 * board lost, or both boards in a thread card with no picture at all.
 *
 * The picture goes to the board these readers act on rather than to the better number -- see
 * `boardInterest` -- so the rest become chips on its picture. Null unless
 * every event in the group is a debut, which is the only shape this is true of: a debut beside a
 * price change is a thread, and a thread is what `storyEmbed` is for.
 */
function leadingDebut(group: StoryRenderEvent[]): { lead: StoryRenderEvent; others: StoryRenderEvent[] } | null {
  if (group.length < 2 || !group.every((event) => isTellableDebut(event))) return null;
  const placed = [...group].sort(
    (one, other) =>
      boardInterest(one) - boardInterest(other) || (boardPlace(one) ?? Infinity) - (boardPlace(other) ?? Infinity),
  );
  const [lead, ...others] = placed as [StoryRenderEvent, ...StoryRenderEvent[]];
  return { lead, others };
}

/** "#8 code" -- the board a lesser debut landed on, short enough to sit beside a score. */
function debutChip(event: StoryRenderEvent): string | null {
  const place = boardPlace(event);
  if (place === null) return null;
  const category = recordFor(event)?.category;
  const board = typeof category === "string" ? category.replace(/\/overall$/, "").replace(/[-_/]+/g, " ") : null;
  return `#${place}${board ? ` ${board}` : ""}`;
}

/** The parts of one message: which stories it shows, the header above them, and their text. */
export function messageParts(
  work: Delivering,
  speaking: BatchEvent[],
): { items: StoryRenderEvent[][]; header: string; blocks: string[]; text: string } {
  const { db, batch, target, destination, summaries, leads, storyIds, now } = work;
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
    const debuts = leadingDebut(group);
    if (group.length > 1 && !debuts) return renderStoryText(group, destination.platform, summaries);
    const event = debuts?.lead ?? (group[0] as StoryRenderEvent);
    const rendered = renderEvent(event, event.url, destination.platform, summaries.get(event.id));
    const lines = rendered.split("\n");
    const heading = lines[0] ?? `Update · ${sourceLabel(event.source)}`;
    const footer = lines.slice(-2).join("\n");
    const content = lines.slice(1, -2).join("\n").trim();
    const compact = content.length > 800 ? `${clip(content, 800)}…` : content;
    return [heading, compact, footer].filter(Boolean).join("\n");
  });
  const text = blocks.join(SEPARATOR);
  return { items, header, blocks, text };
}

/** One stored message of a delivery, and the events it is the telling of. */
function storeMessage(work: Delivering, payload: string, part: number, carried: StoryRenderEvent[] = []): void {
  const { db, batch, target, now } = work;
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
}

/** The cards themselves, the files that travel with them, and which events each one stands for. */
function cardEmbeds(
  work: Delivering,
  items: StoryRenderEvent[][],
): {
  roster: boolean;
  embeds: Record<string, unknown>[];
  attachments: Map<Record<string, unknown>, Attachment>;
  behind: Map<Record<string, unknown>, StoryRenderEvent[]>;
} {
  const { batch, destination, summaries } = work;
  const roster = !batch.digest && items.every((group) => group.length === 1) && isRoster(items.flat());
  const rendered = roster
    ? [rosterEmbed(items.flat(), destination.detail)]
    : items.map((group) => {
        const debuts = leadingDebut(group);
        if (group.length > 1 && !debuts) return storyEmbed(group, summaries, destination.detail);
        const event = debuts?.lead ?? (group[0] as StoryRenderEvent);
        const embed = eventEmbed(event, event.url, summaries.get(event.id), destination.detail);
        const banner = embed.banner as { chips: string[] } | undefined;
        if (banner && debuts)
          banner.chips = [...banner.chips, ...debuts.others.flatMap((other) => debutChip(other) ?? [])].slice(0, 3);
        return embed;
      });
  const embeds = distinctLinks(rendered);
  // An embed and its evidence file travel together: the page an embed lands on decides
  // which message carries its attachment.
  const attachments = new Map<Record<string, unknown>, Attachment>();
  const behind = new Map<Record<string, unknown>, StoryRenderEvent[]>();
  if (roster) behind.set(embeds[0] as Record<string, unknown>, items.flat());
  else
    items.forEach((group, index) => {
      const lead = leadingDebut(group)?.lead ?? (group.length === 1 ? (group[0] as StoryRenderEvent) : null);
      const file = lead ? eventAttachment(lead) : null;
      const embed = embeds[index];
      if (!embed) return;
      if (file) attachments.set(embed, file);
      behind.set(embed, group);
    });
  return { roster, embeds, attachments, behind };
}

/** Who is pinged, and the lines above the cards that say why this is a card at all. */
function cardPings(
  work: Delivering,
  speaking: BatchEvent[],
  embeds: Record<string, unknown>[],
): { roles: string[]; pingLine: string; tookOff: string[] } {
  const { db, batch, destination, vendorRoles, allSignalsRole } = work;
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
  // On Discord the ping reads as a headline: "@Xiaomi · [logo] New Xiaomi models", the way the
  // role menu names the vendor. Telegram drops the mention and has no server emoji to show.
  const title = String(embeds[0]?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
  const emoji = vendors.map((vendor) => VENDOR_EMOJIS[vendor]).find(Boolean);
  const pingLine =
    destination.platform === "discord" && mentions && title
      ? `${mentions} · ${emoji ? `${emoji} ` : ""}${title}`
      : mentions;
  return { roles, pingLine, tookOff };
}

/** One message of cards, for a destination that reads them. */
export function storeCards(
  work: Delivering,
  speaking: BatchEvent[],
  items: StoryRenderEvent[][],
  header: string,
): void {
  const { db, batch, destination, storyIds, target } = work;
  const { roster, embeds, attachments, behind } = cardEmbeds(work, items);
  const { roles, pingLine, tookOff } = cardPings(work, speaking, embeds);
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
  storeMessage(
    work,
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
}

/** The same message as text, for a destination that reads no cards, paged to fit. */
export function storeTextMessages(
  work: Delivering,
  message: { text: string; header: string; blocks: string[]; items: StoryRenderEvent[][] },
): void {
  const { db, batch, target } = work;
  const { text, header, blocks, items } = message;
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
    storeMessage(work, header + body, part, told[part]);
  });
  db.query(
    "DELETE FROM deliveries WHERE batch_id=? AND destination_id=? AND status='pending' AND attempts=0 AND part>=?",
  ).run(batch.id, target.destination_id, parts.length);
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
