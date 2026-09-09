import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
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

function decodeHtml(text: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

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
