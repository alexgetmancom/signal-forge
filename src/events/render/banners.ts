/**
 * The picture a card is screenshotted for, and the words on it.
 *
 * Three kinds: a number worth reading alone (a debut's place, a price's move, a shutdown date), a
 * line worth quoting (a page, a post, a string shipped in an interface), and a person's own words
 * (a reset, which is somebody's announcement before it is anything else). Each returns a banner
 * without its filename, which the card assembles. Moved out of discord.ts unchanged.
 */
import { sourceLabel } from "../../sources/labels.js";
import { text } from "../../text.js";
import { boardPlace, DEBUT_PLACES, intelligenceIndex } from "../boardSignals.js";
import { displayTitle } from "../naming.js";
import type { Event, RecordData } from "../types.js";
import type { Banner } from "./banner.js";
import { describe, type Fact, prices } from "./common.js";
import { dollars, priceChips, priceMove, priceStep } from "./price.js";
import { excerpt, firstSentence, pageName, place, present, shortDate } from "./words.js";

/**
 * The banner's top line says what the card's title does not: when, and that it can be called. A
 * screenshot posted elsewhere loses Discord's timestamp, and the date on the picture is what shows
 * the news was early. "3 new models · Xiaomi" repeated the title word for word.
 */
export function bannerEyebrow(vendor: string, detectedAt: string, where = "API"): string {
  return [vendor === "Unknown" ? null : vendor, where, shortDate(detectedAt)].filter(Boolean).join(" · ");
}

/** "Shutdown · in 23 days": how long is left is what a reader with the model in production needs. */
function shutdownCaption(day: string, from: string): string {
  const days = Math.round((Date.parse(day) - Date.parse(from)) / 86_400_000);
  return days > 0 ? `Shutdown · in ${days} day${days === 1 ? "" : "s"}` : "Shutdown";
}

/**
 * The board a debut happened on, said once. Artificial Analysis names its own categories after
 * itself, and "ARTIFICIAL ANALYSIS · ARTIFICIAL ANALYSIS TEXT TO SPEECH" ran across the chips
 * beside it. The caption has the width of the number above it and no more.
 */
const CAPTION_CHARACTERS = 34;

function boardCaption(board: string, category: string | null): string {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const said = category && !plain(category).includes(plain(board)) ? [board, category] : [category ?? board];
  const caption = said.filter(Boolean).join(" · ");
  return caption.length > CAPTION_CHARACTERS ? (said[0] ?? board) : caption;
}

/**
 * The model a post announces, taken off the front of its headline.
 *
 * A maker titles an announcement as a name and then a claim -- "Gemini 4 Argon: our next era of
 * frontier intelligence" -- and every step that tidies a title for a card reads the claim as the
 * title and drops the name. The name is what a reader repeats, so on this one picture it is taken
 * before any of that tidying, from the record's own headline, and only when what comes off the
 * front reads like a name rather than a sentence.
 */
export function announcedModel(record: RecordData | null, fallback: string): string {
  // The verb belongs to the sentence the maker wrote, not to the model: "Anthropic announced
  // Introducing Claude Opus 5.5" is what keeping it produced on every launch of the last month.
  const headline = text(record?.name)?.replace(/^\s*(?:introducing|announcing|launching|meet|now available:?)\s+/i, "");
  const front = headline?.split(/[:\u2013\u2014|]/)[0]?.trim();
  return front && front.length >= 3 && front.length <= 48 && front.split(/\s+/).length <= 6 ? front : fallback;
}

/**
 * The picture for a change: the line that changed, quoted the size of a headline. Documentation, a
 * maker's changelog and a string in an interface are each read for one sentence, and all three went
 * out as a title over a table of our own bookkeeping.
 */
export function changeBanner(
  event: Event,
  record: RecordData | null,
  vendor: string,
  name: string,
  quotes: readonly Fact[],
): Omit<Banner, "filename" | "logo"> | null {
  const base = { vendor, chips: [] as string[] };
  // "Anthropic · Anthropic · news" said the maker twice: the source already carries whose site it is.
  const where = sourceLabel(event.source);
  const eyebrow = [where, shortDate(event.detected_at, true)].join(" · ");
  if (event.stream === "pages" && event.kind === "new")
    return { ...base, eyebrow, title: pageName(name), change: { mark: "+", where: "On the maker's own site" } };
  /**
   * A maker announcing its own model, which is the one post of the year its readers want to see
   * coming. It gets the shape a launch gets -- the name, large, over the day it was said -- rather
   * than a quoted sentence, because the name is what a reader repeats and the sentence is on the
   * card underneath it. The post's own headline is not the name: "Gemini 4 Argon: our next era of
   * frontier intelligence" is a model and then a slogan, and the slogan is what survived every
   * other treatment of this title.
   */
  if (event.stream === "news" && event.kind === "new" && event.signal === "launch")
    return {
      ...base,
      eyebrow: bannerEyebrow(vendor, event.detected_at, "Announced"),
      title: announcedModel(record, name),
    };
  // A post the maker actually wrote: a feed row carrying a headline and nothing else has nothing
  // for the picture to quote, and a picture of a name is not worth the weight of a picture.
  if (event.stream === "news" && event.kind === "new" && present(record?.summary)) {
    // "Kimi Code CLI v2.1.0" on the picture is the post's number; what it says is the news, and it
    // was left in the text under a picture of its own title.
    const said = firstSentence(String(record?.summary));
    return {
      ...base,
      eyebrow,
      title: said ? excerpt(said, 140) : name,
      change: { mark: "+", where: said ? name : "The maker's own words" },
    };
  }
  if (event.stream === "web" && event.kind === "changed") {
    // The strings a maker ships in its own interface: the first added line is the news, and a card
    // that only loses lines says so with the mark rather than quoting what is gone.
    // An added line reaches here either quoted for Discord, as `> + the line`, or as the value of
    // the field that lists what a page gained.
    const added = /^(?:> )?\+ /;
    const line = quotes.map((fact) => (typeof fact === "string" ? fact : fact.value)).find((text) => added.test(text));
    const text = line?.replace(added, "").trim();
    if (!text) return null;
    // Where the line landed, when the page knows its own name. Without one it fell back to the
    // source, and the footing read "Added to Codex · docs" under a top line saying "CODEX · DOCS".
    const section = typeof record?.title === "string" ? record.title : null;
    return {
      ...base,
      eyebrow,
      title: excerpt(text, 140),
      change: { mark: "+", ...(section ? { where: `Added to ${section}` } : { where: "" }) },
    };
  }
  return null;
}

/**
 * What a debut is read for beside its place: the rating the board scores it with, and what it costs
 * where the board also publishes that.
 *
 * An arena scores in Elo and the chip says "Score 1525". Artificial Analysis scores in an index and
 * publishes a price sheet beside it, and its whole evaluation sheet arrives under `score`, so the
 * rule that looked for a number found an object and the card carried no chip at all -- the two
 * numbers the announcement of Gemini 4 Argon was quoted for, 53 and $2 in / $10 out, both missing
 * from the one card that had them.
 */
function debutChips(event: Event, after: RecordData | null): string[] {
  const index = intelligenceIndex(after);
  if (index !== null)
    return [
      `Index ${Number(index.toFixed(1))}`,
      ...prices(null, after?.pricing, event.source).flatMap((fact) =>
        typeof fact === "string" ? [] : priceChips(fact.value),
      ),
    ].slice(0, 3);
  return [after?.score, after?.rating]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .slice(0, 1)
    .map((value) => `Score ${Math.round(value)}`);
}

/**
 * The picture for a card read for one number -- a debut's place, a price's move, a shutdown date --
 * so the number is what a screenshot shows first. Everything else keeps the plain card.
 */
export function numberBanner(
  event: Event,
  before: RecordData | null,
  after: RecordData | null,
  vendor: string,
  name: string,
): Omit<Banner, "filename" | "logo"> | null {
  const base = { title: name, vendor };
  if (event.stream === "leaderboards" && event.kind === "new") {
    const rank = boardPlace(event);
    if (rank === null || rank > DEBUT_PLACES) return null;
    const board = place(event.source);
    // "text-to-image/overall" is a key; the caption under the place reads "Arena · text to image".
    const category =
      typeof after?.category === "string"
        ? after.category
            .replace(/\/overall$/, "")
            .replace(/[-_/]+/g, " ")
            .trim() || null
        : null;
    return {
      ...base,
      eyebrow: bannerEyebrow(vendor, event.detected_at, "Debut"),
      chips: debutChips(event, after),
      hero: {
        text: `#${rank}`,
        caption: boardCaption(board, category),
        color: rank === 1 ? 0xf5c451 : 0xffffff,
      },
    };
  }
  if ((event.stream === "api-models" || event.stream === "openrouter") && before && after) {
    const move = priceMove(event, before, after);
    if (!move) return null;
    return {
      ...base,
      eyebrow: bannerEyebrow(vendor, event.detected_at, `Price on ${place(event.source)}`),
      chips: [`${dollars(move.from)} → ${dollars(move.to)} per 1M ${move.field}`],
      hero: {
        text: priceStep(move.from, move.to),
        caption: move.to < move.from ? "cheaper" : "dearer",
        color: move.to < move.from ? 0x3ddc84 : 0xff5c5c,
      },
    };
  }
  if (event.stream === "deprecations" && event.kind === "new" && after) {
    const shutdown = after.shutdown ?? after.retirement ?? after.deprecated;
    const day = typeof shutdown === "string" && !Number.isNaN(Date.parse(shutdown)) ? shutdown : null;
    if (!day) return null;
    return {
      ...base,
      // Two dates on one picture read as one: the top line says which is the announcement.
      eyebrow: [vendor === "Unknown" ? null : vendor, `Announced ${shortDate(event.detected_at)}`]
        .filter(Boolean)
        .join(" · "),
      chips: present(after.replacement)
        ? [`Replaced by ${displayTitle(describe(after.replacement), "api-models", event.source)}`]
        : [],
      hero: { text: shortDate(day), caption: shutdownCaption(day, event.detected_at), color: 0xffa94d },
    };
  }
  return null;
}

/**
 * The confirmed reset in the announcer's own words: "Reset all propagated. Sweet dreams." is the
 * line people repost, so the card quotes it and names who said it rather than paraphrasing it.
 */
/**
 * The people who announce resets, by their X handle: the name a reader knows them by and the photo
 * that sits in the corner, since a reset is his word before it is anything else.
 */
export const ANNOUNCERS: Record<string, { name: string; photo: string }> = {
  thsottiaux: { name: "Tibo, Codex at OpenAI", photo: "thsottiaux.png" },
};

export const resetAuthor = (record: RecordData | null) =>
  typeof record?.announcement === "string" ? record.announcement.match(/@(\w+)/)?.[1] : undefined;

/** The announcer's own words, big enough to read in a screenshot, with who said them under. */
export const resetPost = (record: RecordData | null) =>
  typeof record?.summary === "string" ? record.summary.replace(/https:\/\/t\.co\/\S+/g, "").trim() : "";

export function resetWords(record: RecordData | null): string | null {
  const post = resetPost(record);
  const author = resetAuthor(record);
  if (!post || !record) return null;
  const quote = excerpt(post, 280)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `### ${line}`)
    .join("\n");
  if (!author) return quote;
  return `${quote}\n— [${ANNOUNCERS[author]?.name ?? `@${author}`}](https://x.com/${author})`;
}

export function resetConfirmation(record: RecordData): string {
  return resetWords(record) ?? "Seen by the tracker without a post. Usage limits are back.";
}

/** When a promised reset is due, if the tracker knows: "2026-09-22 18:00 UTC" as a Unix second. */
export function resetDue(record: RecordData | null): number | null {
  if (record?.stage === "Applied" || typeof record?.expected !== "string") return null;
  const at = Date.parse(record.expected.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

export const bannerName = (key: string) =>
  `banner-${key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)}.png`;
