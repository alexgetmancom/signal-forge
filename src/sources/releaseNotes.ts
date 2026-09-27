import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { slug } from "../text.js";
import { withAudience } from "./audienceJudge.js";
import { attribute, htmlText, sections } from "./html.js";
import { fetchText } from "./http.js";

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

const releaseRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.url(),
    maker: z.string().min(1),
    published: z.string().datetime({ offset: true }),
    summary: z.string().min(1).max(1_200),
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

function utcDate(year: number, month: number, day: number, source: string): string {
  const time = Date.UTC(year, month, day);
  const date = new Date(time);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  )
    throw new Error(`${source}: invalid publication date`);
  return date.toISOString();
}

function publicationDate(value: string, source: string, fallbackYear?: number): string {
  const normalized = htmlText(value).replace(/\s+/g, " ").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), source);
  const full = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(normalized);
  if (full) {
    const month = monthNumbers[(full[1] ?? "").toLowerCase()];
    if (month === undefined) throw new Error(`${source}: invalid publication date`);
    return utcDate(Number(full[3]), month, Number(full[2]), source);
  }
  const monthDay = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(normalized);
  if (monthDay && fallbackYear !== undefined) {
    const month = monthNumbers[(monthDay[1] ?? "").toLowerCase()];
    if (month === undefined) throw new Error(`${source}: invalid publication date`);
    return utcDate(fallbackYear, month, Number(monthDay[2]), source);
  }
  throw new Error(`${source}: invalid publication date`);
}

/** Whether a heading carries a date at all, which is what separates entries from navigation. */
function isDate(value: string, source: string, fallbackYear?: number): boolean {
  try {
    publicationDate(value, source, fallbackYear);
    return true;
  } catch {
    return false;
  }
}

/** The calendar day of a publication instant, which is what every record id is built from. */
function dayOf(published: string): string {
  return published.slice(0, 10);
}

const SUMMARY_LIMIT = 1_200;

function contentBlocks(value: string): string {
  const blocks = [...value.matchAll(/<(p|ul|ol|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi)].map((match) =>
    htmlText(match[0] ?? ""),
  );
  return (blocks.length ? blocks.join(" ") : htmlText(value)).trim();
}

function releaseCollection(source: string, url: string, records: RecordData[]): Collection {
  if (!records.length) throw new Error(`${source}: release notes have no dated entries`);
  const parsed = releaseRecordsSchema.parse(records) as RecordData[];
  return {
    source,
    stream: "news",
    url,
    // Store normalized evidence: the upstream HTML contains rotating framework metadata and
    // would otherwise create a new snapshot on every unchanged poll.
    raw: parsed,
    appendOnly: true,
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
    const month = monthHeadings.filter((candidate) => candidate.index < headingIndex).at(-1);
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
  if (!article) throw new Error("OpenAI ChatGPT release notes article not found");
  const days = sections(article, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (heading) =>
    isDate(htmlText(heading[1] ?? ""), "openai-chatgpt-release-notes"),
  );
  const records = days.flatMap((day) => {
    const published = publicationDate(htmlText(day.match[1] ?? ""), "openai-chatgpt-release-notes");
    return sections(day.body, /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi).flatMap((entry, entryIndex) => {
      const name = htmlText(entry.match[1] ?? "");
      if (!name) return [];
      const summary = contentBlocks(entry.body).slice(0, SUMMARY_LIMIT) || name;
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
  const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const dateOf = (heading: RegExpMatchArray): string =>
    attribute(heading[1] ?? "", "data-text") ?? htmlText(heading[2] ?? "");
  const records = sections(content, /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (heading) =>
    isDate(dateOf(heading), "gemini-api-changelog"),
  ).map(({ match, body }) => {
    const dateText = dateOf(match);
    const published = publicationDate(dateText, "gemini-api-changelog");
    const anchor = attribute(match[1] ?? "", "id") ?? dayOf(published);
    const summary = contentBlocks(body).slice(0, SUMMARY_LIMIT) || dateText;
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
  if (!Number.isInteger(year)) throw new Error(`${source}: page year not found`);
  return year;
}

/** Parse xAI's month-grouped release notes, whose cards carry their day beside each heading. */
export function parseXaiReleaseNotes(html: string): Collection {
  const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const year = pageYear(html, "xai-release-notes");
  const monthHeadings = [...content.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi)].flatMap((heading) => {
    const text = htmlText(heading[2] ?? "");
    const match = /^([A-Za-z]+)(?:\s+(\d{4}))?$/.exec(text);
    const month = monthNumbers[(match?.[1] ?? "").toLowerCase()];
    if (heading.index === undefined || month === undefined || !match) return [];
    return [{ index: heading.index, month, year: Number(match[2] ?? year) }];
  });
  const dateMarkers = [
    ...content.matchAll(
      /<div\b[^>]*class="[^"]*\btext-muted\b[^"]*"[^>]*>\s*<div\b[^>]*class="relative"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
    ),
  ].flatMap((marker) => (marker.index === undefined ? [] : [{ index: marker.index, text: htmlText(marker[1] ?? "") }]));
  const headings = [...content.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/gi)];
  const records = headings.flatMap((heading, index) => {
    if (heading.index === undefined) return [];
    const marker = dateMarkers.filter((candidate) => candidate.index < heading.index).at(-1);
    const month = monthHeadings.filter((candidate) => candidate.index < heading.index).at(-1);
    const name = htmlText(heading[2] ?? "");
    const anchor = attribute(heading[1] ?? "", "id") ?? slug(name);
    if (!marker || !month || !name || !anchor) return [];
    const published = publicationDate(marker.text, "xai-release-notes", month.year);
    const nextHeading = headings[index + 1]?.index ?? content.length;
    const nextMonth = monthHeadings.find((candidate) => candidate.index > heading.index)?.index ?? content.length;
    const sectionEnd = Math.min(nextHeading, nextMonth);
    const summary =
      contentBlocks(content.slice(heading.index + heading[0].length, sectionEnd)).slice(0, SUMMARY_LIMIT) || name;
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
  const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const records = sections(content, /<time\b([^>]*)>([\s\S]*?)<\/time>/gi, (time) =>
    Boolean(attribute(time[1] ?? "", "dateTime")),
  ).flatMap(({ match, body }) => {
    const date = publicationDate(attribute(match[1] ?? "", "dateTime") ?? "", "mistral-release-notes");
    const heading = body.match(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/i);
    if (!heading || heading.index === undefined) return [];
    const name = htmlText(heading[2] ?? "");
    if (!name) return [];
    const summary = contentBlocks(body.slice(heading.index + heading[0].length)).slice(0, SUMMARY_LIMIT) || name;
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
  const dateMarkers = [
    ...html.matchAll(/<span\b[^>]*class="[^"]*\btext-xs\b[^"]*\bsticky\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi),
  ].flatMap((marker) => (marker.index === undefined ? [] : [{ index: marker.index, text: htmlText(marker[1] ?? "") }]));
  // Every h3 bounds the one before it, including the navigation headings this ignores.
  const records = sections(html, /<h3\b([^>]*)>([\s\S]*?)<\/h3>/gi).flatMap(({ match, index, body }) => {
    if (!/\bmt-12\b/.test(attribute(match[1] ?? "", "class") ?? "")) return [];
    const marker = dateMarkers.filter((candidate) => candidate.index < index).at(-1);
    const name = htmlText(match[2]?.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? match[2] ?? "");
    const anchor = attribute(match[1] ?? "", "id") ?? slug(name);
    if (!marker || !name || !anchor) return [];
    const published = publicationDate(marker.text, "groq-changelog", year);
    const summary = contentBlocks(body).slice(0, SUMMARY_LIMIT) || name;
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
    const summary = contentBlocks(match[2] ?? "").slice(0, SUMMARY_LIMIT);
    if (!version || !date || !summary) return [];
    // One historical entry is dated to a month with no day. A publication date is not invented
    // here; the entry is left out, and a wholesale format change empties the collection instead,
    // which the collector reports as a failed read.
    let published: string;
    try {
      published = publicationDate(date, "kimi-code-changelog");
    } catch {
      return [];
    }
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
