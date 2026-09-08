import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
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
