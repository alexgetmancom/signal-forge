import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Collection } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import type { Fetch } from "../http-client.js";
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
      published: new Date(item.pubDate).toISOString(),
    })),
  };
}
export async function collectOpenAINews(request: Fetch = fetch): Promise<Collection> {
  return parseOpenAINews(await fetchText("https://openai.com/news/rss.xml", {}, request));
}

const anthropicItem =
  /<li><a href="(\/news\/[^"]+)"[^>]*>.*?<time[^>]*>([^<]+)<\/time>.*?<span[^>]*subject[^>]*>([^<]*)<\/span>.*?<span[^>]*title[^>]*>([^<]+)<\/span><\/a><\/li>/gs;

export function parseAnthropicNews(html: string): Collection {
  const records = [...html.matchAll(anthropicItem)].map((match) => {
    const path = match[1] ?? "";
    return {
      id: `https://www.anthropic.com${path}`,
      name: decodeHtml(match[4] ?? "").trim(),
      url: `https://www.anthropic.com${path}`,
      category: decodeHtml(match[3] ?? "").trim() || null,
      published: new Date(`${match[2]} UTC`).toISOString(),
    };
  });
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

export async function collectAnthropicNews(request: Fetch = fetch): Promise<Collection> {
  return parseAnthropicNews(await fetchText("https://www.anthropic.com/news", {}, request));
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
