import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Collection } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import type { Fetch } from "../http-client.js";
import { calendarDate } from "./feeds.js";
import { decodeHtml } from "./html.js";
import { fetchText } from "./http.js";

const feedSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z
        .array(
          z.object({
            title: z.string().min(1),
            link: z.url(),
            description: z.string().default(""),
            pubDate: z.string(),
          }),
        )
        .min(1),
    }),
  }),
});
export function parseOpenAINews(text: string): Collection {
  if (XMLValidator.validate(text) !== true) throw new Error("Invalid RSS XML");
  const raw: unknown = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    isArray: (name) => name === "item",
  }).parse(text);
  const items = feedSchema.parse(raw).rss.channel.item;
  return {
    source: "openai-news",
    stream: "news",
    url: "https://openai.com/news/",
    raw,
    appendOnly: true,
    records: items.map((item) => ({
      id: item.link,
      name: item.title,
      url: item.link,
      description: item.description
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      published: newsDate(item.pubDate),
    })),
  };
}
function newsDate(value: string): string {
  const date = calendarDate(value);
  if (!date) throw new Error(`Source news item has invalid publication date: ${value}`);
  return date.toISOString();
}

export async function collectOpenAINews(request: Fetch = fetch): Promise<Collection> {
  return parseOpenAINews(await fetchText("https://openai.com/news/rss.xml", {}, request));
}

const anthropicItem =
  /<li><a href="(\/news\/[^"]+)"[^>]*>.*?<time[^>]*>([^<]+)<\/time>.*?<span[^>]*subject[^>]*>([^<]*)<\/span>.*?<span[^>]*title[^>]*>([^<]+)<\/span><\/a><\/li>/gs;

/**
 * The featured grid above the list. It is where the launches go, and they do not live under `/news/`:
 * "Introducing Claude Fable 5.1 and Claude Mythos 5.1" is `/claude-fable-and-mythos-5-1` and the
 * September threat report is an absolute URL. Reading only the list missed both, and the source
 * reported success with a newest entry of 2026-09-01 until 2026-09-17.
 */
const anthropicFeatured = /<a href="((?:https:\/\/www\.anthropic\.com)?\/[^"]+)" class="FeaturedGrid[^"]*"[^>]*>/g;

/** One featured card, read up to the next link: the lead card puts its title before its date, the side cards after. */
function anthropicFeaturedCards(html: string) {
  return [...html.matchAll(anthropicFeatured)].flatMap((match) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = html.indexOf("<a href", start);
    const card = html.slice(start, end < 0 ? undefined : end);
    const title = /<h[2-6][^>]*>([^<]+)<\/h[2-6]>/.exec(card)?.[1];
    const date = /<time[^>]*>([^<]+)<\/time>/.exec(card)?.[1];
    const category = /<span[^>]*>([^<]*)<\/span><time/.exec(card)?.[1] ?? "";
    return title && date ? [anthropicRecord(match[1] ?? "", date, category, title)] : [];
  });
}

function anthropicRecord(href: string, date: string, category: string, title: string) {
  const url = href.startsWith("https://") ? href : `https://www.anthropic.com${href}`;
  return {
    id: url,
    name: decodeHtml(title).trim(),
    url,
    category: decodeHtml(category).trim() || null,
    published: newsDate(`${date} UTC`),
  };
}

export function parseAnthropicNews(html: string): Collection {
  const listed = [...html.matchAll(anthropicItem)].map((match) =>
    anthropicRecord(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? ""),
  );
  const featured = anthropicFeaturedCards(html);
  const records = [...new Map([...featured, ...listed].map((record) => [record.id, record])).values()];
  if (!records.length) throw new Error("Anthropic newsroom entries not found");
  return {
    source: "anthropic-news",
    stream: "news",
    url: "https://www.anthropic.com/news",
    raw: html,
    appendOnly: true,
    records,
  };
}

/**
 * A newsroom whose newest entry is this old has not gone quiet, its page has changed shape. Anthropic
 * has not gone a month without a post; a parse that still finds old entries is a failure, not a
 * catalogue.
 */
const STALE_NEWSROOM_MS = 30 * 24 * 3_600_000;

function freshNewsroom(collection: Collection, now: Date): Collection {
  const newest = Math.max(...collection.records.map((record) => Date.parse(String(record.published ?? ""))));
  if (!Number.isFinite(newest) || now.getTime() - newest > STALE_NEWSROOM_MS)
    throw new Error(`${collection.source} newest entry is older than thirty days`);
  return collection;
}

export async function collectAnthropicNews(request: Fetch = fetch, now = new Date()): Promise<Collection> {
  return freshNewsroom(parseAnthropicNews(await fetchText("https://www.anthropic.com/news", {}, request)), now);
}

/**
 * The pages anthropic.com is built with, listed in every page's route data. A launch page is in the
 * list before it is linked: `claude-opus-5-5` was there at 03:23 UTC on 2026-09-22, beside the
 * published `claude-fable-and-mythos-5-1`, and gone again by the afternoon. Only the slugs that start with "claude-" and
 * hold a number are kept; "careers" and "claude-corps" are the site, "redeploying-fable-5" an article.
 */
export function parseAnthropicRoutes(html: string): Collection {
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/\\?"\/?([a-z0-9-]+)\\?"/g))
    if (slug && /^claude-[a-z0-9-]*\d/.test(slug)) slugs.add(slug);
  if (!/\\?"slug\\?",\\?"news\\?"/.test(html)) throw new Error("Anthropic route list not found");
  return {
    source: "anthropic-routes",
    stream: "github",
    url: "https://www.anthropic.com/news",
    raw: [...slugs].sort().join("\n"),
    records: [...slugs]
      .sort()
      .map((slug) => ({ id: slug, name: slug, maker: "Anthropic", url: `https://www.anthropic.com/${slug}` })),
  };
}

export async function collectAnthropicRoutes(request: Fetch = fetch): Promise<Collection> {
  return parseAnthropicRoutes(await fetchText("https://www.anthropic.com/news", {}, request));
}

const claudeBlogItem =
  /<h2 class="u-text-style-h6[^"]*">([^<]+)<\/h2><div class="u-text-style-caption[^"]*">([^<]+)<\/div><\/div><div class="clickable_wrap[^"]*"><a [^>]*href="(\/blog\/[^"]+)"/g;

/**
 * Claude's product blog, which is where Anthropic announces what Claude does rather than what the
 * company thinks. "Claude Cowork and chat are now one Claude", with Claude Docs and Claude Slides,
 * was posted here on 2026-09-16 and nowhere on anthropic.com/news.
 */
export function parseClaudeBlog(html: string): Collection {
  const records = [
    ...new Map(
      [...html.matchAll(claudeBlogItem)].map((match) => {
        const url = `https://claude.com${match[3]}`;
        return [
          url,
          { id: url, name: decodeHtml(match[1] ?? "").trim(), url, published: newsDate(`${match[2]} UTC`) },
        ] as const;
      }),
    ).values(),
  ];
  if (!records.length) throw new Error("Claude blog entries not found");
  return {
    source: "claude-blog",
    stream: "news",
    url: "https://claude.com/blog",
    raw: html,
    appendOnly: true,
    records,
  };
}

export async function collectClaudeBlog(request: Fetch = fetch, now = new Date()): Promise<Collection> {
  return freshNewsroom(parseClaudeBlog(await fetchText("https://claude.com/blog", {}, request)), now);
}

const hackerNewsSchema = z.object({
  hits: z.array(
    z.object({
      objectID: z.string().min(1),
      title: z.string().min(1),
      url: z.string().nullish(),
      points: z.number().int().nonnegative(),
      created_at: z.string().min(1),
    }),
  ),
});

/**
 * Hacker News is how much attention a release got, never the release. "Gemini 3.8 Live and 3.8 Live
 * Extended Thinking" reached 480 points on 2026-09-16, a day after the Gemini API docs named it. So
 * it is a witness: its stories join the vendor's story and show up as corroboration, and no post of
 * its own is ever a card -- the class is `article`, which no destination takes.
 *
 * Only the front of the site counts, and only a title that names a maker this deployment follows:
 * of 73 stories over 100 points in two days, most were about oil markets and FPGAs.
 */
const HACKER_NEWS_POINTS = 100;
const HACKER_NEWS_WINDOW_SECONDS = 2 * 24 * 3600;

export function parseHackerNews(payload: string): Collection {
  const raw: unknown = JSON.parse(payload);
  const stories = hackerNewsSchema.parse(raw).hits.filter((hit) => vendorOfName(hit.title) !== "Unknown");
  return {
    source: "hackernews",
    stream: "news",
    url: "https://news.ycombinator.com/",
    raw,
    appendOnly: true,
    records: stories.map((hit) => ({
      id: hit.objectID,
      name: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      discussion: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      published: new Date(hit.created_at).toISOString(),
    })),
  };
}

export async function collectHackerNews(request: Fetch = fetch, now = Date.now()): Promise<Collection> {
  const since = Math.floor(now / 1000) - HACKER_NEWS_WINDOW_SECONDS;
  const filters = encodeURIComponent(`points>${HACKER_NEWS_POINTS},created_at_i>${since}`);
  return parseHackerNews(
    await fetchText(
      `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=${filters}&hitsPerPage=200`,
      { accept: "application/json" },
      request,
    ),
  );
}
