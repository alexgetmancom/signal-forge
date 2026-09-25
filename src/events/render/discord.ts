/**
 * A card, assembled.
 *
 * What is left here is the assembly and nothing else: the parts are decided next door -- the title
 * by `headline.ts`, the sentence by `shape.ts`, the pills by `spec.ts`, the picture by `banners.ts`
 * -- and this file lays them out, spends the description budget, and decides what a card drops once
 * its picture already carries it. `rosterEmbed` is the same assembly for several models arriving at
 * once, which Discord would otherwise fold into one.
 */
import { sourceLabel } from "../../sources/labels.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import { isStealthLaunch } from "../signals.js";
import type { Event, RecordData } from "../types.js";
import type { Banner } from "./banner.js";
import {
  ANNOUNCERS,
  bannerEyebrow,
  bannerName,
  changeBanner,
  numberBanner,
  resetAuthor,
  resetDue,
  resetPost,
} from "./banners.js";
import { DESCRIPTION_CHARACTERS } from "./budget.js";
import { type Fact, factText, withoutMakerPrefix } from "./common.js";
import { type CardContext, eventFactParts } from "./facts.js";
import {
  eventHeadline,
  eyebrow,
  incidentLook,
  MODEL_STREAMS,
  mentionSighting,
  SIGHTINGS,
  withUntrackedMaker,
} from "./headline.js";
import { sourceLogo, vendorColor, vendorLogo } from "./logos.js";
import { cardColor } from "./palette.js";
import { shape } from "./shape.js";
import {
  isLaunch,
  launchChips,
  STEALTH_NOISE,
  specLine,
  stealthChips,
  stealthName,
  stealthVenues,
  VENUE_NOISE,
  VENUES,
} from "./spec.js";
import { capital, type Detail, excerpt, footerText, listed, place, shortDate } from "./words.js";

/** What a news reader is spared: identity bookkeeping and the values only a scout checks. */
const EVIDENCE_ONLY = new Set(["Identity", "Also known as", "Variant", "Votes", "Architecture", "Provider", "Changes"]);

/** Discord shows at most 25 fields; a card with more than this many is a table nobody reads. */
const MAX_FIELDS = 6;

/** A value longer than this breaks a three-column row and gets the full width instead. */
const INLINE_CHARACTERS = 28;

/**
 * Labelled facts become the card's fields; sentences stay in the description. The fields follow the
 * facts' own order, and a fact past the field budget goes back into the text rather than away.
 */
function factLayout(facts: Fact[]): { lines: string[]; fields: Record<string, unknown>[] } {
  const lines: string[] = [];
  const fields: Record<string, unknown>[] = [];
  for (const fact of facts) {
    if (typeof fact === "string") lines.push(fact);
    else if (fields.length < MAX_FIELDS)
      fields.push({
        name: fact.label.slice(0, 256),
        value: fact.value.slice(0, 1024) || "—",
        inline: fact.value.length <= INLINE_CHARACTERS,
      });
    else lines.push(factText(fact));
  }
  return { lines, fields };
}

export function eventEmbed(
  event: Event & CardContext,
  url: string,
  summary?: string,
  detail: Detail = "evidence",
): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const link =
    typeof record?.url === "string" && record.url.trim()
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  const vendor = vendorOf(event, record);
  const rawName = String(record?.name ?? event.entity_id);
  const shown = displayTitle(rawName, event.stream, event.source);
  const stripped = withoutMakerPrefix(shown);
  const named = stripped === shown ? shown : capital(stripped);
  const untouchedName = withUntrackedMaker(named, vendor, record);
  const all = eventFactParts(event).filter((fact) => factText(fact).toLowerCase() !== `maker: ${vendor.toLowerCase()}`);
  const shaped = shape(event, before, after, vendor, all);
  const facts = shaped.facts.filter(
    (fact) =>
      detail === "evidence" || (typeof fact === "string" ? !/^> [+−] /.test(fact) : !EVIDENCE_ONLY.has(fact.label)),
  );
  const launch = isLaunch(event, vendor);
  const stealth = isStealthLaunch(event);
  // The venue spells a stealth model `space-bunny-free` and `stealth/space-bunny-alpha`; the model
  // is Space Bunny, and the spelling stays in the handle underneath for copying.
  const name = stealth ? stealthName(event) : untouchedName;
  const newModel = event.kind === "new" && MODEL_STREAMS.has(event.stream);
  const spec = newModel
    ? specLine(
        stealth
          ? facts.filter((fact) => typeof fact === "string" || !STEALTH_NOISE.has(fact.label.toLowerCase()))
          : VENUES.has(event.source)
            ? facts.filter((fact) => typeof fact === "string" || !VENUE_NOISE.has(fact.label.toLowerCase()))
            : facts,
      )
    : { line: null, chips: [], rest: facts };
  const venues = stealthVenues(event);
  if (launch && !stealth) spec.chips = launchChips(event, spec.chips);
  if (stealth) {
    // The picture carries what the model is; the text carries only what the picture cannot, which
    // is where to call it and what to type. The first card said "free" three times over.
    spec.chips = stealthChips(event, spec.chips);
    spec.line = null;
    spec.rest = [];
  }
  const { lines, fields } = factLayout(spec.rest);
  // The name a developer copies into an API call: on every new model, and for a scout whenever the
  // headline prettified it.
  const bareId = String(record?.id ?? event.entity_id);
  const handle =
    event.stream === "training" || event.stream === "resets"
      ? null
      : newModel && !/\s/.test(bareId)
        ? `\`${bareId}\``
        : detail === "evidence" &&
            rawName !== name &&
            !/\s/.test(rawName) &&
            event.stream !== "packages" &&
            !mentionSighting(event)
          ? `\`${rawName}\``
          : null;
  // A new model's title already says where it appeared, and the footer says it again.
  const sentence = newModel && /^Added to /.test(shaped.sentence ?? "") ? null : shaped.sentence;
  const alsoOn = stealth && venues.others.length ? `Also on ${listed(venues.others)}` : null;
  const description = [
    ...(summary ? [`*${summary}*`] : []),
    ...(alsoOn ? [alsoOn] : []),
    ...(sentence ? [sentence] : []),
    ...(spec.line ? [spec.line] : []),
    ...lines,
    ...(handle ? [handle] : []),
  ]
    .join("\n")
    .slice(0, DESCRIPTION_CHARACTERS);
  const incident = incidentLook(event, record);
  const color = cardColor({
    incident: incident?.color,
    stream: event.stream,
    kind: event.kind,
    stealth,
    vendor,
    branded:
      (event.kind === "new" && (MODEL_STREAMS.has(event.stream) || SIGHTINGS.has(event.stream))) ||
      (event.kind === "changed" && SIGHTINGS.has(event.stream)),
    applied: record?.stage === "Applied",
  });
  const sourceIcon = sourceLogo(event.source);
  const embed: Record<string, unknown> = {
    // A new model's title and banner name the maker and the moment; an eyebrow would say it a third time.
    // A sighting's maker is its logo in the corner; "REPOSITORY · OPENAI" above it named our feed
    // and the maker again. The eyebrow stays where there is no logo to say who.
    ...(newModel || (SIGHTINGS.has(event.stream) && vendorLogo(vendor))
      ? {}
      : {
          author: {
            name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
            ...(sourceIcon ? { icon_url: sourceIcon } : {}),
          },
        }),
    title: (stealth
      ? `🚀 ${name} is out — free on ${venues.headline}`
      : launch
        ? `🚀 ${name} is out`
        : newModel && event.stream !== "weights"
          ? `🆕 ${name} on ${place(event.source)}`
          : eventHeadline(event, name, incident)
    ).slice(0, 250),
    color,
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    // Discord renders its own timestamp in the reader's timezone, which is one line of card spent
    // on something the client already does.
    timestamp: new Date(event.detected_at).toISOString(),
    footer: {
      text: footerText(
        stealth ? venues.source : event.source,
        event.confidence ?? "observed",
        // A maker's own status page is not a rumour; "unconfirmed" under it read as doubt about the outage.
        // A sighting's emoji and sentence already say nobody has announced it.
        SIGHTINGS.has(event.stream) ? "brief" : detail,
        event.stream === "web" ? "not shipped yet" : undefined,
      ),
    },
  };
  const logo = vendorLogo(vendor)?.slice("attachment://".length) ?? null;
  // A reset, promised or confirmed, shows the person who announced it rather than the maker's tile.
  const announcer = event.stream === "resets" ? ANNOUNCERS[resetAuthor(after) ?? ""] : undefined;
  const thumbnail = announcer ? `attachment://${announcer.photo}` : logo ? `attachment://${logo}` : null;
  const words: Omit<Banner, "filename" | "logo"> | null = stealth
    ? {
        // No maker to name, so the picture says what it is instead: unclaimed, free, and where.
        // The title says where it is free; the picture says what the title cannot, which is that
        // nobody has put their name on it and what day it appeared.
        eyebrow: ["Stealth", shortDate(event.detected_at)].join(" · "),
        title: name,
        chips: spec.chips,
        vendor,
        glow: color,
        stealth: true,
      }
    : launch
      ? { eyebrow: bannerEyebrow(vendor, event.detected_at), title: name, chips: spec.chips, vendor, glow: color }
      : (numberBanner(event, before, after, vendor, name) ?? changeBanner(event, after, vendor, name, shaped.facts));
  const post = announcer ? resetPost(after) : "";
  if (announcer && after && post) {
    // A reset is a person's word: the post is the picture, and the card under it keeps what a picture
    // cannot, the timer that counts down on every screen and the link to who said it.
    const applied = after.stage === "Applied";
    const due = resetDue(after);
    const day = new Date(event.detected_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const banner: Banner = {
      eyebrow: `Codex · ${applied ? "limits are back" : "reset announced"} · ${day}`,
      title: excerpt(post.replace(/\s+/g, " "), 140),
      chips: [],
      vendor,
      filename: bannerName(`${event.source}-${event.entity_id}-${applied ? "applied" : "announced"}`),
      logo: null,
      quote: {
        by: announcer.name,
        portrait: announcer.photo,
        ...(due !== null ? { due } : {}),
        ...(applied ? { accent: 0x3ddc84 } : {}),
      },
    };
    // The picture names who said it and the title links to the post, so the text keeps only the
    // timer, which Discord counts down in each reader's own time.
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
    if (due !== null) embed.description = `Resets <t:${due}:R> · <t:${due}:t> your time.`;
    else delete embed.description;
  } else if (words) {
    const banner: Banner = { ...words, filename: bannerName(`${event.source}-${event.entity_id}`), logo };
    // The banner carries the maker's tile, so the corner stays empty rather than showing it twice.
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
    // A change keeps its words: the picture quotes the line, and the text says what it means.
    if (!launch && !banner.change) trimToBanner(embed, banner, handle, event.source);
    // The line is on the picture now, and it was in the text cut off mid-word: "See AWS Regional
    // availa". What stays is the count, which the picture does not carry.
    else if (banner.change && typeof embed.description === "string") {
      const kept = embed.description.split("\n").filter((line) => !/^> [+−] /.test(line));
      // A maker's changelog is one sentence, and the picture is that sentence. Printed above the
      // picture as well, the card said the same thing twice, the second time larger. The card keeps
      // the version in its title, the link under it, and nothing else.
      const said = banner.change.mark === "+" && event.stream === "news";
      if (said) delete embed.description;
      else embed.description = kept.join("\n");
      if (!said && !kept.length) delete embed.description;
    }
  } else if (thumbnail && (description || fields.length)) embed.thumbnail = { url: thumbnail };
  // A title alone beside a logo left a logo-high empty card above; the stripe says whose it is.
  if (link) embed.url = link;
  return embed;
}

/**
 * A card whose picture carries its number says nothing else: the first debut card said #1 four times
 * -- eyebrow, title, a sentence and the banner -- and a price card quoted its move three. What stays
 * is the title to click, the ID to copy and the source; the stripe takes the number's colour.
 */
function trimToBanner(embed: Record<string, unknown>, banner: Banner, handle: string | null, source: string): void {
  delete embed.author;
  // "Arena · leaderboards" names our feed; the reader wants the place, as a price card's "OpenRouter".
  const footer = embed.footer as { text: string };
  footer.text = footer.text.replace(sourceLabel(source), place(source));
  delete embed.fields;
  if (handle) embed.description = handle;
  else delete embed.description;
  const hero = banner.hero;
  if (!hero) return;
  // The picture is read for the number, so the title says only which way it went: "27% cheaper"
  // above a −27% the size of the card was the same fact twice.
  if (hero.caption === "cheaper" || hero.caption === "dearer")
    embed.title = `${hero.caption === "cheaper" ? "💸" : "📈"} ${banner.title} is ${hero.caption}`;
  embed.color =
    hero.color === 0xffffff || hero.color === 0xf5c451 ? (vendorColor(banner.vendor) ?? embed.color) : hero.color;
  // The number decides the colour, so the picture is lit by it rather than by the maker's brand.
  banner.glow = embed.color as number;
}

/** The words two names share at the start: "MiMo V2.6" of "MiMo V2.6 Flash" and "MiMo V2.6 Pro". */
function sharedStem(names: string[]): string {
  const split = names.map((name) => name.split(/\s+/));
  const stem: string[] = [];
  for (const [index, word] of (split[0] ?? []).entries()) {
    if (split.every((words) => words[index]?.toLowerCase() === word.toLowerCase())) stem.push(word);
    else break;
  }
  return stem.join(" ");
}

/**
 * Several models arriving together, as one card: "3 new Xiaomi models" with a line for each.
 *
 * On 2026-09-21 Xiaomi's API listed MiMo V2.6 Flash, Pro and Pro Ultraspeed in one poll. The message
 * carried three cards, but all three linked to the same catalogue page and Discord folds embeds that
 * share a link into the first, so the channel showed Flash alone under "3 updates". A launch of a
 * family is one piece of news, and a card that lists it is also the one worth a screenshot.
 */
export function rosterEmbed(
  events: (Event & CardContext & { url: string })[],
  detail: Detail = "evidence",
): Record<string, unknown> {
  const cards = events.map((event) => eventEmbed(event, event.url, undefined, detail));
  const first = events[0] as Event & { url: string };
  const record = first.after_json ? (JSON.parse(first.after_json) as RecordData) : null;
  const vendor = vendorOf(first, record);
  const maker = vendor === "Unknown" ? null : vendor;
  const lines = cards.map((card, index) => {
    const event = events[index] as Event;
    const title = String(card.title ?? "")
      .replace(/^\S+\s+/, "")
      .replace(/ (?:is out|on .+)$/, "");
    const spec =
      typeof card.description === "string" ? /^\*\*.+ context.*$|^\*\*.+per 1M tokens$/m.exec(card.description) : null;
    const fields = ((card.fields ?? []) as { name: string; value: string }[])
      .filter((field) => !EVIDENCE_ONLY.has(field.name))
      .slice(0, 3)
      .map((field) => `${field.name} ${field.value}`);
    const id = event.entity_id.split("/").at(-1) ?? event.entity_id;
    // `mimo-v2.6-pro` says "MiMo V2.6 Pro" already; a name is shown only when it tells more.
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, "");
    const named = /\s/.test(id) || plain(title) !== plain(id);
    const link = typeof card.url === "string" && card.url !== first.url ? `[${title}](${card.url})` : title;
    const head = /\s/.test(id) ? `**${link}**` : named ? `**${link}** · \`${id}\`` : `\`${id}\``;
    const under = [...(spec ? [spec[0].replace(/\*\*/g, "")] : []), ...fields];
    return [head, ...under].join(" · ");
  });
  const embed: Record<string, unknown> = {
    title: `🚀 ${events.length} new ${maker ? `${maker} ` : ""}models`,
    color: cardColor({ stream: first.stream, kind: "new", vendor, branded: true }),
    description: clipLines(lines, DESCRIPTION_CHARACTERS),
    timestamp: new Date(first.detected_at).toISOString(),
    footer: { text: footerText(first.source, first.confidence ?? "observed", detail) },
  };
  const thumbnail = vendorLogo(vendor);
  if (maker && isLaunch(first, vendor)) {
    const names = cards.map((card) =>
      String(card.title ?? "")
        .replace(/^\S+\s+/, "")
        .replace(/ is out$/, ""),
    );
    const stem = sharedStem(names);
    const banner: Banner = {
      filename: bannerName(`${first.source}-${first.entity_id}-roster`),
      eyebrow: bannerEyebrow(maker, first.detected_at),
      title: stem || `${events.length} new models`,
      chips: names.map((name) => (stem ? name.slice(stem.length).trim() : name) || name),
      vendor,
      logo: thumbnail ? thumbnail.slice("attachment://".length) : null,
    };
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
  } else if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (first.url) embed.url = first.url;
  return embed;
}

/** Whole lines up to the limit: a model's line is never cut in half. */
function clipLines(lines: string[], limit: number): string {
  let kept = "";
  for (const line of lines) {
    if (`${kept}\n${line}`.length > limit) break;
    kept = kept ? `${kept}\n${line}` : line;
  }
  return kept;
}

/**
 * A message of cards where each is one new model by one maker from the same catalogue reads as one
 * roster. Two makers on a reseller's list are two stories, and past eight names a list is a wall.
 */
export function isRoster(events: readonly Event[]): boolean {
  const first = events[0];
  if (!first || events.length < 2 || events.length > MAX_ROSTER) return false;
  const maker = (event: Event) =>
    vendorOf(event, event.after_json ? (JSON.parse(event.after_json) as RecordData) : null);
  const vendor = maker(first);
  return (
    vendor !== "Unknown" &&
    events.every(
      (event) =>
        event.kind === "new" &&
        MODEL_STREAMS.has(event.stream) &&
        event.source === first.source &&
        maker(event) === vendor,
    )
  );
}

const MAX_ROSTER = 8;
