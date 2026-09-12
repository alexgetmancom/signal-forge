import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { slug } from "../text.js";
import { htmlText } from "./html.js";
import { fetchText } from "./http.js";

const CLAUDE_CODE_CHANGELOG_URL = "https://code.claude.com/docs/en/changelog.md";
const ANTHROPIC_SDK_RELEASES_URL = "https://platform.claude.com/docs/en/release-notes/overview.md";
const OPENAI_CODEX_CHANGELOG_URL = "https://developers.openai.com/codex/changelog";
const OPENAI_CODEX_CHANGELOG_FEED_URL = "https://learn.chatgpt.com/docs/changelog/rss.xml";
const HUGGINGFACE_BLOG_FEED_URL = "https://huggingface.co/blog/feed.xml";

const xmlTextSchema = z.union([z.string(), z.object({ "#text": z.string() }).passthrough()]);

const rssSchema = z.object({
  rss: z.object({ channel: z.object({ item: z.array(z.unknown()).min(1) }) }),
});
const atomSchema = z.object({ feed: z.object({ entry: z.array(z.unknown()).min(1) }) });
const feedItemSchema = z.object({
  title: z.unknown(),
  link: z.unknown().optional(),
  guid: z.unknown().optional(),
  id: z.unknown().optional(),
  pubDate: z.unknown().optional(),
  published: z.unknown().optional(),
  updated: z.unknown().optional(),
  description: z.unknown().optional(),
  summary: z.unknown().optional(),
  encoded: z.unknown().optional(),
});

type FeedOptions = {
  source: string;
  maker: string;
  url: string;
  include?: (title: string, description: string) => boolean;
};

function textValue(value: unknown, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Official feed item has no ${field}`);
    return "";
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => textValue(entry, field))
      .filter(Boolean)
      .join(" ");
    if (required && !text.trim()) throw new Error(`Official feed item has no ${field}`);
    return text;
  }
  const parsed = xmlTextSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Official feed item has invalid ${field}`);
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data["#text"];
  if (required && !text.trim()) throw new Error(`Official feed item has no ${field}`);
  return text;
}

function feedLink(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const alternate = value.find(
      (entry) =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["@_rel"] === "alternate",
    );
    return feedLink(alternate ?? value[0]);
  }
  if (value && typeof value === "object") {
    const href = (value as Record<string, unknown>)["@_href"];
    if (typeof href === "string") return href;
  }
  throw new Error("Official feed item has no valid link");
}

function publishedDate(value: string): string {
  const normalized = value.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error(`Official feed item has invalid publication date: ${value}`);
  return date.toISOString();
}

function sourceCollection(options: FeedOptions, raw: unknown, records: RecordData[]): Collection {
  if (!records.length) throw new Error(`${options.source}: feed has no matching entries`);
  return {
    source: options.source,
    stream: "news",
    url: options.url,
    raw,
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

/** Parse RSS 2.0 and Atom without trusting the feed's presentation markup. */
export function parseOfficialFeed(text: string, options: FeedOptions): Collection {
  if (XMLValidator.validate(text) !== true) throw new Error(`${options.source}: invalid XML`);
  const raw: unknown = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name) => name === "item" || name === "entry" || name === "link",
  }).parse(text);
  const rss = rssSchema.safeParse(raw);
  const atom = atomSchema.safeParse(raw);
  const items = rss.success ? rss.data.rss.channel.item : atom.success ? atom.data.feed.entry : null;
  if (!items) throw new Error(`${options.source}: unsupported feed shape`);
  const records = items.map((unknownItem) => {
    const item = feedItemSchema.passthrough().parse(unknownItem);
    const title = textValue(item.title, "title", true).trim();
    const encoded = item.encoded === undefined ? "" : textValue(item.encoded, "description");
    const description = encoded.trim()
      ? markdownText(htmlText(encoded))
      : htmlText(textValue(item.description ?? item.summary, "description"));
    const url = z.url().parse(feedLink(item.link ?? item.guid ?? item.id));
    const date = textValue(item.pubDate ?? item.published ?? item.updated, "publication date", true);
    return {
      id: url,
      name: title,
      url,
      maker: options.maker,
      published: publishedDate(date),
      description: description.slice(0, 1_200),
    } satisfies RecordData;
  });
  const filtered = options.include
    ? records.filter((record) => options.include?.(record.name, String(record.description ?? "")))
    : records;
  return sourceCollection(options, raw, [...new Map(filtered.map((record) => [record.id, record])).values()]);
}

function markdownText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseCollection(source: string, url: string, raw: string, records: RecordData[]): Collection {
  if (!records.length) throw new Error(`${source}: release notes have no dated entries`);
  return { source, stream: "news", url, raw, appendOnly: true, trackChanges: true, records };
}

export function parseClaudeCodeChangelog(markdown: string): Collection {
  const records = [
    ...markdown.matchAll(/<Update\b[^>]*label="([^"]+)"[^>]*description="([^"]+)"[^>]*>([\s\S]*?)<\/Update>/g),
  ].map((match) => {
    const version = match[1] ?? "";
    const date = match[2] ?? "";
    return {
      id: `claude-code:${version}`,
      name: `Claude Code ${version}`,
      url: CLAUDE_CODE_CHANGELOG_URL.replace(/\.md$/, ""),
      maker: "Anthropic",
      version,
      published: publishedDate(date),
      summary: markdownText(match[3] ?? "").slice(0, 1_200),
    } satisfies RecordData;
  });
  return releaseCollection("claude-code-changelog", CLAUDE_CODE_CHANGELOG_URL, markdown, records);
}

export function parseAnthropicSdkReleases(markdown: string): Collection {
  const headings = [...markdown.matchAll(/^###\s+([^\n]+)$/gm)];
  const records = headings.flatMap((heading, index) => {
    const dateText = heading[1] ?? "";
    if (
      !/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(dateText)
    )
      return [];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(start, end);
    const date = publishedDate(dateText);
    const summary = markdownText(body).slice(0, 1_200);
    return [
      {
        id: `anthropic-sdk:${date.slice(0, 10)}:${slug(summary.slice(0, 80))}`,
        name: `Anthropic SDK and API · ${date.slice(0, 10)}`,
        url: ANTHROPIC_SDK_RELEASES_URL.replace(/\.md$/, ""),
        maker: "Anthropic",
        published: date,
        summary,
      } satisfies RecordData,
    ];
  });
  return releaseCollection("anthropic-sdk-releases", ANTHROPIC_SDK_RELEASES_URL, markdown, records);
}

export async function collectClaudeCodeChangelog(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseClaudeCodeChangelog(await fetchText(CLAUDE_CODE_CHANGELOG_URL, {}, request, undefined, cache));
}
export async function collectAnthropicSdkReleases(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseAnthropicSdkReleases(await fetchText(ANTHROPIC_SDK_RELEASES_URL, {}, request, undefined, cache));
}

export async function collectOpenAICodexChangelog(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOfficialFeed(await fetchText(OPENAI_CODEX_CHANGELOG_FEED_URL, {}, request, undefined, cache), {
    source: "openai-codex-changelog",
    maker: "OpenAI",
    url: OPENAI_CODEX_CHANGELOG_URL,
    include: (title) => !/^ChatGPT for (?:iOS|Android)$/i.test(title.trim()),
  });
}

export async function collectHuggingFaceBlogFeed(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOfficialFeed(await fetchText(HUGGINGFACE_BLOG_FEED_URL, {}, request, undefined, cache), {
    source: "huggingface-blog-feed",
    maker: "Hugging Face",
    url: HUGGINGFACE_BLOG_FEED_URL,
  });
}
