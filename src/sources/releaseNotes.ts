import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { slug } from "../text.js";
import { withAudience } from "./audienceJudge.js";
import { attribute, htmlText, sections } from "./html.js";
import { fetchText } from "./http.js";
import { distinctIds } from "./ids.js";

const OPENAI_CHATGPT_RELEASE_NOTES_URL = "https://help.openai.com/en/articles/6825453-chatgpt-release-notes";
const OPENAI_CHATGPT_RELEASE_NOTES_FETCH_URL = `${OPENAI_CHATGPT_RELEASE_NOTES_URL}.json`;
const OPENAI_API_CHANGELOG_URL = "https://developers.openai.com/api/docs/changelog";
const OPENAI_API_CHANGELOG_FETCH_URL = `${OPENAI_API_CHANGELOG_URL}.md`;
const GEMINI_API_CHANGELOG_URL = "https://ai.google.dev/gemini-api/docs/changelog";
const XAI_RELEASE_NOTES_URL = "https://docs.x.ai/developers/release-notes";
const MISTRAL_RELEASE_NOTES_URL = "https://docs.mistral.ai/resources/release-notes";
const GROQ_CHANGELOG_URL = "https://console.groq.com/docs/changelog";
const KIMI_CODE_CHANGELOG_URL = "https://www.kimi.com/code/docs/en/kimi-code/whats-new.html";
const MINIMAX_CODE_CHANGELOG_URL = "https://agent.minimax.io/docs/changelog";
const MINIMAX_CODE_CHANGELOG_FETCH_URL = `${MINIMAX_CODE_CHANGELOG_URL}.md`;

const SUMMARY_LIMIT = 1_200;

const releaseRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.url(),
    maker: z.string().min(1),
    published: z.string().datetime({ offset: true }),
    summary: z.string().min(1).max(SUMMARY_LIMIT),
  })
  .passthrough();
const releaseRecordsSchema = z.array(releaseRecordSchema).min(1);

const monthNumbers: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * A date is read exactly or the read fails. The one parser that skips an entry instead is Kimi's, and
 * only for the single entry it knows is dated to a month.
 *
 * Skipping is the kind thing to do for a stray typo and the wrong thing for a vendor changing how it
 * writes dates: the newest entries are the ones that would stop parsing while the older ones carried
 * on, and the source would look healthy while missing every new release, which is the one thing it is
 * read for. Failing says so on the board, by type, and the entries are all there once it is fixed.
 * That holds for a heading deciding whether it is an entry at all: see `readDate`.
 */
function invalidDate(source: string): SourceError {
  return new SourceError("schema", `${source}: invalid publication date`);
}

/**
 * What a heading starts with when it is written as a date, in any of the ways a vendor writes one:
 * `September 18, 2026`, `September 18 2026`, `Sep. 18, 2026`, `18 September 2026`, `2026-09-18`,
 * `9/18/2026`. Wider than what `readDate` reads, and deliberately so: the gap between the two is
 * every heading that must fail loudly rather than be taken for navigation.
 */
const WRITTEN_AS_DATE =
  /^(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})/;

/** The forms a date is read from. A comma is optional: `December 13 2023` is on Gemini's own page. */
const MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/;
const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const MONTH_DAY = /^([A-Za-z]{3,9})\s+(\d{1,2})$/;

/**
 * What a heading is, which is the one question both callers ask and the one place it is answered.
 *
 * `not-a-date` is navigation -- "Release notes", "Version 2 notes", "Related pages" -- and is left
 * out. `unreadable` is a heading written as a date that this parser does not read, and is a failure:
 * the newest entries are the ones a vendor's new format reaches first, so a format that is dropped
 * quietly leaves the source looking healthy while the release it exists to report is missing.
 *
 * It used to be two: `WRITTEN_AS_DATE` decided whether a heading was an entry and a separate set of
 * patterns read it, and the comma they disagreed about took both Gemini and ChatGPT down on
 * 2026-10-02 over `December 13 2023`, an entry from the page's own archive. One reading, so the two
 * cannot disagree again: a shape that is read is a date, and anything else written as one is a
 * failure by construction.
 */
type DateReading = "not-a-date" | "unreadable" | { published: string };

function calendarDay(year: number, month: number | undefined, day: number): DateReading {
  if (month === undefined) return "unreadable";
  const date = new Date(Date.UTC(year, month, day));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  )
    return "unreadable";
  return { published: date.toISOString() };
}

function readDate(value: string, fallbackYear?: number): DateReading {
  const text = htmlText(value).replace(/\s+/g, " ").trim();
  const monthDayYear = MONTH_DAY_YEAR.exec(text);
  if (monthDayYear)
    return calendarDay(
      Number(monthDayYear[3]),
      monthNumbers[(monthDayYear[1] ?? "").toLowerCase()],
      Number(monthDayYear[2]),
    );
  const iso = ISO_DAY.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const monthDay = MONTH_DAY.exec(text);
  if (monthDay && fallbackYear !== undefined)
    return calendarDay(fallbackYear, monthNumbers[(monthDay[1] ?? "").toLowerCase()], Number(monthDay[2]));
  return WRITTEN_AS_DATE.test(text) ? "unreadable" : "not-a-date";
}

/** The date of something already known to be an entry: anything but a date it reads is the failure. */
function publicationDate(value: string, source: string, fallbackYear?: number): string {
  const reading = readDate(value, fallbackYear);
  if (typeof reading === "string") throw invalidDate(source);
  return reading.published;
}

/** Whether a heading is an entry's date, which is what separates entries from navigation. */
function isDate(value: string, source: string): boolean {
  const reading = readDate(value);
  if (reading === "unreadable") throw invalidDate(source);
  return reading !== "not-a-date";
}

/** The calendar day of a publication instant, which is what every record id is built from. */
function dayOf(published: string): string {
  return published.slice(0, 10);
}

/** The page's `<main>`, or the whole page when it has none. */
function mainOf(html: string): string {
  return html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
}

/**
 * The page's own footer, which belongs to the page and not to the last entry on it.
 *
 * A dated section runs to the next heading, and the last one runs to the end of the content, so it
 * swallows whatever the site puts below: Google's devsite signs every page with its licence, its
 * trademarks and the day it was last built. The day is the part that moves. On 2026-10-06 "Last
 * updated 2026-10-01 UTC" became "2026-10-06 UTC" and the Gemini API changelog entry for
 * 2023-12-13 went out as news, three years late, because that one byte was inside its summary.
 *
 * One record of the hundred and forty carries it, which is the last one; the fix is worth its one
 * re-read rather than a rule about which entries may speak.
 */
const PAGE_FOOTER = /^(?:except as otherwise noted|last updated \d{4}-\d{2}-\d{2}|java is a registered trademark)/i;

/** What a block of markup says, cut to the length a record keeps, or the fallback when it says nothing. */
function summaryOf(html: string, fallback: string): string {
  return contentBlocks(html).slice(0, SUMMARY_LIMIT) || fallback;
}

/** Every match of `pattern` as its position in the page and the text of its first group. */
function markersOf(content: string, pattern: RegExp): { index: number; text: string }[] {
  return [...content.matchAll(pattern)].flatMap((marker) =>
    marker.index === undefined ? [] : [{ index: marker.index, text: htmlText(marker[1] ?? "") }],
  );
}

/** The last of `items`, which are in document order, that starts before `index`. */
function lastBefore<T extends { index: number }>(items: readonly T[], index: number): T | undefined {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((items[middle] as T).index < index) low = middle + 1;
    else high = middle;
  }
  return items[low - 1];
}

function contentBlocks(value: string): string {
  const blocks = [...value.matchAll(/<(p|ul|ol|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi)].map((match) =>
    htmlText(match[0] ?? ""),
  );
  // The footer is a block of its own, so the entry ends where it begins rather than at a sentence
  // boundary guessed out of the joined text.
  const footer = blocks.findIndex((block) => PAGE_FOOTER.test(block.trim()));
  const kept = footer < 0 ? blocks : blocks.slice(0, footer);
  return (kept.length ? kept.join(" ") : htmlText(value)).trim();
}

function releaseCollection(source: string, url: string, records: RecordData[]): Collection {
  if (!records.length) throw new SourceError("missing-content", `${source}: release notes have no dated entries`);
  const parsed = distinctIds(releaseRecordsSchema.parse(records) as RecordData[]);
  return {
    source,
    stream: "news",
    url,
    // Store normalized evidence: the upstream HTML contains rotating framework metadata and
    // would otherwise create a new snapshot on every unchanged poll.
    raw: parsed,
    trackChanges: true,
    records: parsed,
  };
}

/**
 * Fetch, then parse. Written out per vendor this was eight functions differing in a URL and a parse,
 * and the argument list -- `(request, cache)` in that order, with the cache optional -- had to be
 * repeated correctly eight times for the registry to be able to call any of them.
 */
function collector(url: string, parse: (body: string) => Collection) {
  return async (request: Fetch = fetch, cache?: HttpCache): Promise<Collection> =>
    parse(await fetchText(url, {}, request, undefined, cache));
}

/** The same, for the two pages whose entries are judged for audience before they are stored. */
function judgedCollector(url: string, parse: (body: string) => Collection) {
  const read = collector(url, parse);
  return async (
    request: Fetch = fetch,
    cache?: HttpCache,
    judge?: { db: Database; config: AppConfig },
  ): Promise<Collection> => {
    const collection = await read(request, cache);
    if (!judge) return collection;
    const records = await withAudience(judge.db, judge.config, request, collection.source, collection.records);
    return { ...collection, records };
  };
}

function markdownSummary(value: string): string {
  return htmlText(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMarkdownLink(value: string): { label: string; url: string } | null {
  const match = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/.exec(value);
  if (!match) return null;
  const label = htmlText(match[1] ?? "").trim();
  const url = match[2] ?? "";
  return label && url ? { label, url } : null;
}

const GENERIC_LINK_LABEL = /^(here|this|link|docs?|documentation|guide|learn more|read more|more|see more)\.?$/i;

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
}

/** Parse OpenAI's month- and day-grouped API changelog Markdown. */
export function parseOpenAIApiChangelog(markdown: string): Collection {
  const monthHeadings = [...markdown.matchAll(/^##\s+([A-Za-z]+),\s+(\d{4})\s*$/gm)].map((match) => ({
    index: match.index ?? -1,
    year: match[2] ?? "",
  }));
  const dateHeadings = [...markdown.matchAll(/^###\s+([A-Za-z]+\s+\d{1,2})\s*$/gm)];
  const records = dateHeadings.flatMap((heading, index) => {
    const headingIndex = heading.index ?? -1;
    if (headingIndex < 0) return [];
    const month = lastBefore(monthHeadings, headingIndex);
    if (!month) return [];
    const published = publicationDate(`${heading[1] ?? ""}, ${month.year}`, "openai-api-changelog");
    const sectionStart = headingIndex + heading[0].length;
    const nextDate = dateHeadings[index + 1]?.index ?? markdown.length;
    const nextMonth = monthHeadings.find((candidate) => candidate.index > headingIndex)?.index ?? markdown.length;
    const section = markdown.slice(sectionStart, Math.min(nextDate, nextMonth));
    const lines = section.split(/\r?\n/);
    const firstContent = lines.findIndex((line) => line.trim());
    if (firstContent < 0) return [];
    const metadata = lines[firstContent]?.trim() ?? "";
    const body = lines.slice(firstContent + 1).join("\n");
    const link = firstMarkdownLink(body);
    const summary = markdownSummary(body) || markdownSummary(metadata);
    // A link reading "here" or "learn more" is where the entry points, not what it says: the
    // Responses API file-input entry reached the public channel titled "here" on 2026-09-17.
    const label = link?.label && !GENERIC_LINK_LABEL.test(link.label) ? link.label : "";
    const name = (label || firstSentence(summary) || metadata).slice(0, 200);
    if (!name || !summary) return [];
    const identity = slug(link?.url ?? `${metadata}:${name}`) || `entry-${index}`;
    return [
      {
        id: `openai-api:${dayOf(published)}:${identity}`,
        name,
        url: OPENAI_API_CHANGELOG_URL,
        maker: "OpenAI",
        published,
        summary: summary.slice(0, SUMMARY_LIMIT),
      } satisfies RecordData,
    ];
  });
  return releaseCollection("openai-api-changelog", OPENAI_API_CHANGELOG_URL, records);
}

export const collectOpenAIApiChangelog = collector(OPENAI_API_CHANGELOG_FETCH_URL, parseOpenAIApiChangelog);

/** Parse the dated article sections from OpenAI's ChatGPT Help Center release notes. */
export function parseOpenAIChatGPTReleaseNotes(html: string): Collection {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (!article) throw new SourceError("missing-content", "OpenAI ChatGPT release notes article not found");
  const days = sections(article, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (heading) =>
    isDate(htmlText(heading[1] ?? ""), "openai-chatgpt-release-notes"),
  );
  const records = days.flatMap((day) => {
    const published = publicationDate(htmlText(day.match[1] ?? ""), "openai-chatgpt-release-notes");
    return sections(day.body, /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi).flatMap((entry, entryIndex) => {
      const name = htmlText(entry.match[1] ?? "");
      if (!name) return [];
      const summary = summaryOf(entry.body, name);
      return [
        {
          id: `${dayOf(published)}:${slug(name) || `entry-${entryIndex}`}`,
          name,
          url: OPENAI_CHATGPT_RELEASE_NOTES_URL,
          maker: "OpenAI",
          published,
          summary,
        } satisfies RecordData,
      ];
    });
  });
  return releaseCollection("openai-chatgpt-release-notes", OPENAI_CHATGPT_RELEASE_NOTES_URL, records);
}

export const collectOpenAIChatGPTReleaseNotes = judgedCollector(
  OPENAI_CHATGPT_RELEASE_NOTES_FETCH_URL,
  parseOpenAIChatGPTReleaseNotes,
);

/** Parse one dated section per entry from Google's official Gemini API changelog. */
export function parseGeminiApiChangelog(html: string): Collection {
  const content = mainOf(html);
  const dateOf = (heading: RegExpMatchArray): string =>
    attribute(heading[1] ?? "", "data-text") ?? htmlText(heading[2] ?? "");
  const records = sections(content, /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (heading) =>
    isDate(dateOf(heading), "gemini-api-changelog"),
  ).map(({ match, body }) => {
    const dateText = dateOf(match);
    const published = publicationDate(dateText, "gemini-api-changelog");
    const anchor = attribute(match[1] ?? "", "id") ?? dayOf(published);
    const summary = summaryOf(body, dateText);
    return {
      id: dayOf(published),
      name: `Gemini API changelog · ${dayOf(published)}`,
      url: `${GEMINI_API_CHANGELOG_URL}#${anchor}`,
      maker: "Google",
      published,
      summary,
    } satisfies RecordData;
  });
  return releaseCollection("gemini-api-changelog", GEMINI_API_CHANGELOG_URL, records);
}

export const collectGeminiApiChangelog = collector(GEMINI_API_CHANGELOG_URL, parseGeminiApiChangelog);

function pageYear(html: string, source: string): number {
  const yearText =
    html.match(/(?:Last updated|dateModified)[\s\S]{0,100}?((?:19|20)\d{2})/i)?.[1] ??
    html.match(/\b((?:19|20)\d{2})-\d{2}-\d{2}\b/)?.[1];
  const year = Number(yearText);
  if (!Number.isInteger(year)) throw new SourceError("missing-content", `${source}: page year not found`);
  return year;
}

/** Parse xAI's month-grouped release notes, whose cards carry their day beside each heading. */
export function parseXaiReleaseNotes(html: string): Collection {
  const content = mainOf(html);
  const year = pageYear(html, "xai-release-notes");
  const monthHeadings = [...content.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi)].flatMap((heading) => {
    const text = htmlText(heading[2] ?? "");
    const match = /^([A-Za-z]+)(?:\s+(\d{4}))?$/.exec(text);
    const month = monthNumbers[(match?.[1] ?? "").toLowerCase()];
    if (heading.index === undefined || month === undefined || !match) return [];
    return [{ index: heading.index, month, year: Number(match[2] ?? year) }];
  });
  const dateMarkers = markersOf(
    content,
    /<div\b[^>]*class="[^"]*\btext-muted\b[^"]*"[^>]*>\s*<div\b[^>]*class="relative"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
  );
  const headings = [...content.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/gi)];
  const records = headings.flatMap((heading, index) => {
    if (heading.index === undefined) return [];
    const marker = lastBefore(dateMarkers, heading.index);
    const month = lastBefore(monthHeadings, heading.index);
    const name = htmlText(heading[2] ?? "");
    const anchor = attribute(heading[1] ?? "", "id") ?? slug(name);
    if (!marker || !month || !name || !anchor) return [];
    const published = publicationDate(marker.text, "xai-release-notes", month.year);
    const nextHeading = headings[index + 1]?.index ?? content.length;
    const nextMonth = monthHeadings.find((candidate) => candidate.index > heading.index)?.index ?? content.length;
    const sectionEnd = Math.min(nextHeading, nextMonth);
    const summary = summaryOf(content.slice(heading.index + heading[0].length, sectionEnd), name);
    return [
      {
        id: `${dayOf(published)}:${anchor}`,
        name,
        url: `${XAI_RELEASE_NOTES_URL}#${anchor}`,
        maker: "xAI",
        published,
        summary,
      } satisfies RecordData,
    ];
  });
  return releaseCollection("xai-release-notes", XAI_RELEASE_NOTES_URL, records);
}

export const collectXaiReleaseNotes = collector(XAI_RELEASE_NOTES_URL, parseXaiReleaseNotes);

/** Parse the dated cards from Mistral's official release-notes page. */
export function parseMistralReleaseNotes(html: string): Collection {
  const content = mainOf(html);
  const records = sections(content, /<time\b([^>]*)>([\s\S]*?)<\/time>/gi, (time) =>
    Boolean(attribute(time[1] ?? "", "dateTime")),
  ).flatMap(({ match, body }) => {
    const date = publicationDate(attribute(match[1] ?? "", "dateTime") ?? "", "mistral-release-notes");
    const heading = body.match(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/i);
    if (!heading || heading.index === undefined) return [];
    const name = htmlText(heading[2] ?? "");
    if (!name) return [];
    const summary = summaryOf(body.slice(heading.index + heading[0].length), name);
    return [
      {
        id: `${dayOf(date)}:${slug(name)}`,
        name,
        url: MISTRAL_RELEASE_NOTES_URL,
        maker: "Mistral",
        published: date,
        summary,
      } satisfies RecordData,
    ];
  });
  return releaseCollection("mistral-release-notes", MISTRAL_RELEASE_NOTES_URL, records);
}

export const collectMistralReleaseNotes = judgedCollector(MISTRAL_RELEASE_NOTES_URL, parseMistralReleaseNotes);

/** Parse Groq's dated changelog cards while ignoring its navigation headings. */
export function parseGroqChangelog(html: string): Collection {
  const year = pageYear(html, "groq-changelog");
  const dateMarkers = markersOf(
    html,
    /<span\b[^>]*class="[^"]*\btext-xs\b[^"]*\bsticky\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
  );
  // Every h3 bounds the one before it, including the navigation headings this ignores.
  const records = sections(html, /<h3\b([^>]*)>([\s\S]*?)<\/h3>/gi).flatMap(({ match, index, body }) => {
    if (!/\bmt-12\b/.test(attribute(match[1] ?? "", "class") ?? "")) return [];
    const marker = lastBefore(dateMarkers, index);
    const name = htmlText(match[2]?.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? match[2] ?? "");
    const anchor = attribute(match[1] ?? "", "id") ?? slug(name);
    if (!marker || !name || !anchor) return [];
    const published = publicationDate(marker.text, "groq-changelog", year);
    const summary = summaryOf(body, name);
    return [
      {
        id: `${dayOf(published)}:${anchor}`,
        name,
        url: `${GROQ_CHANGELOG_URL}#${anchor}`,
        maker: "Groq",
        published,
        summary,
      } satisfies RecordData,
    ];
  });
  return releaseCollection("groq-changelog", GROQ_CHANGELOG_URL, records);
}

export const collectGroqChangelog = collector(GROQ_CHANGELOG_URL, parseGroqChangelog);

/**
 * Moonshot ships Kimi Code faster than it ships models, and the release notes are where a model
 * reaches the product: a coding model is announced here under the alias the CLI calls, which is
 * not the ID the Moonshot API answers to. This is evidence about the product, and never on its
 * own evidence that a model ID has become callable.
 *
 * The page renders each release as one `wn-entry` block carrying its own product, version and
 * date, so the entries are read as records rather than as one document that changed.
 */
export function parseKimiCodeChangelog(html: string): Collection {
  const records = [
    // `wn-entry` is a class token: the newest release and every model release also carry `wn-hero`,
    // and matching the attribute exactly lost four of them on 2026-09-18, Kimi K3 among them.
    ...html.matchAll(
      /<div class="(?:[^"]*\s)?wn-entry(?:\s[^"]*)?">([\s\S]*?)<div class="wn-content">([\s\S]*?)<\/div>/g,
    ),
  ].flatMap((match) => {
    const meta = match[1] ?? "";
    const version = htmlText(meta.match(/<span class="ignore-header">([\s\S]*?)<\/span>/)?.[1] ?? "");
    const date = htmlText(meta.match(/<span class="wn-date">([\s\S]*?)<\/span>/)?.[1] ?? "");
    const product = htmlText(meta.match(/<span class="wn-product">([\s\S]*?)<\/span>/)?.[1] ?? "Kimi Code");
    const summary = summaryOf(match[2] ?? "", "");
    if (!version || !date || !summary) return [];
    // One historical entry is dated to a month with no day (`May 2026`). A publication date is not
    // invented here, so that entry is left out. Any other date that does not read fails the read like
    // every other parser's: a catch-all here skipped `14 Sept 2026` as quietly as `May 2026`, and the
    // newest release was the one it would have skipped.
    if (/^[A-Za-z]+\s+\d{4}$/.test(date)) return [];
    const published = publicationDate(date, "kimi-code-changelog");
    return [
      {
        id: `kimi-code:${dayOf(published)}:${slug(version)}`,
        // A heading can already name the product ("Kimi Code Desktop is here"), and "Model Release"
        // is the page's category for a model, not a product the model belongs to.
        name: version.startsWith(product) || product === "Model Release" ? version : `${product} ${version}`,
        url: KIMI_CODE_CHANGELOG_URL,
        maker: "Moonshot",
        version,
        published,
        summary,
      } satisfies RecordData,
    ];
  });
  return releaseCollection("kimi-code-changelog", KIMI_CODE_CHANGELOG_URL, records);
}

export const collectKimiCodeChangelog = collector(KIMI_CODE_CHANGELOG_URL, parseKimiCodeChangelog);

/**
 * MiniMax Code ships a desktop build or a CLI release most days, and none of it reaches the MiniMax
 * API catalogue or the Hugging Face organisation this service already reads. The changelog is one
 * page with a tab per product; its Markdown rendering carries the same entries without the download
 * cards' markup.
 *
 * Each tab spells a heading its own way: `v3.0.73 — 2026-09-18` on the desktop, `0.4.12 · 2026-09-18`
 * for the CLI and a bare date for the web agent. A heading without a date (two desktop builds of
 * June 2026) is left out rather than dated by its neighbours.
 */
export function parseMiniMaxCodeChangelog(markdown: string): Collection {
  const records = [...markdown.matchAll(/<Tab title="([^"]+)">([\s\S]*?)<\/Tab>/g)].flatMap((tab) => {
    const product = tab[1] === "Web" ? "MiniMax Agent" : `MiniMax Code ${tab[1]}`;
    return (tab[2] ?? "")
      .split(/^\s*## /m)
      .slice(1)
      .flatMap((entry) => {
        const heading = entry.slice(0, entry.indexOf("\n")).trim();
        const dated = /^(?:(.+?)\s+[—·]\s+)?(\d{4}-\d{2}-\d{2})$/.exec(heading);
        if (!dated) return [];
        const version = (dated[1] ?? "").replace(/\\/g, "").replace(/\s+/g, "");
        const published = publicationDate(dated[2] ?? "", "minimax-code-changelog");
        const summary = markdownSummary(
          entry
            .slice(heading.length)
            .replace(/<CardGroup[\s\S]*?<\/CardGroup>/g, " ")
            .replace(/<[^>]+>/g, " "),
        ).slice(0, SUMMARY_LIMIT);
        if (!summary) return [];
        return [
          {
            id: `minimax-code:${dayOf(published)}:${slug(`${tab[1]} ${version}`)}`,
            name: version ? `${product} ${version}` : `${product} · ${dayOf(published)}`,
            url: MINIMAX_CODE_CHANGELOG_URL,
            maker: "MiniMax",
            ...(version ? { version } : {}),
            published,
            summary,
          } satisfies RecordData,
        ];
      });
  });
  return releaseCollection("minimax-code-changelog", MINIMAX_CODE_CHANGELOG_URL, records);
}

export const collectMiniMaxCodeChangelog = collector(MINIMAX_CODE_CHANGELOG_FETCH_URL, parseMiniMaxCodeChangelog);
