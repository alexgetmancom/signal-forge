import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * What Qwen, MiniMax and Moonshot publish about a model, from the machine-readable copies behind
 * their sites. None of the three has a feed or a sitemap that lists model pages, and qwen.ai renders
 * in the browser, so each is read where its own front end or docs engine reads it:
 *
 * - qwen.ai's blog loads its posts from `/api/v2/article/retrieval`, found in the site's bundle on
 *   2026-09-22; the list is not in date order, so a post is new when its id is.
 * - MiniMax's docs, on Mintlify, serve every page as markdown: the model release notes are one
 *   6 KB file of dated cards.
 * - Z.ai's release notes, Mintlify too, give each model an `<Update>` with its date and name.
 * - Kimi's docs, also Mintlify, list every page in `llms.txt`, and each model gets a quickstart
 *   (`guide/kimi-k3-quickstart`) when it launches.
 * - Xiaomi has no feed and its sitemap lists only model and API pages, so MiMo's releases were
 *   reaching this tracker as a URL with a version in it. Its own `llms.txt` names every post under
 *   "Latest News" with the title it was published under, which is where "Xiaomi MiMo-V2.5 series
 *   open-sourced" and "MiMo-V2.5-TTS-Series + ASR Officially Launched" are announced.
 */
type LabPage = { id: string; name: string; maker: string; url: string };

export const LAB_PAGE_SOURCES = {
  "qwen-blog": "Qwen",
  "minimax-release-notes": "MiniMax",
  "kimi-docs": "Moonshot",
  "zai-release-notes": "Z.ai",
  "xiaomi-news": "Xiaomi",
} as const;

type LabPageSource = keyof typeof LAB_PAGE_SOURCES;

const URLS: Record<LabPageSource, string> = {
  "qwen-blog": "https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US",
  "minimax-release-notes": "https://platform.minimax.io/docs/release-notes/models.md",
  "kimi-docs": "https://platform.kimi.ai/docs/llms.txt",
  "zai-release-notes": "https://docs.z.ai/release-notes/new-released.md",
  "xiaomi-news": "https://mimo.mi.com/llms.txt",
};

export function qwenPosts(json: string): LabPage[] {
  const body = JSON.parse(json) as { data?: { articles?: { id?: unknown; title?: unknown }[] } };
  const articles = body.data?.articles;
  if (!Array.isArray(articles)) throw new Error("qwen.ai returned no article list");
  return articles.flatMap((article) =>
    typeof article.id === "string" && typeof article.title === "string"
      ? [{ id: article.id, name: article.title, maker: "Qwen", url: `https://qwen.ai/blog?id=${article.id}` }]
      : [],
  );
}

export function minimaxReleases(markdown: string): LabPage[] {
  return [...markdown.matchAll(/<Card\s+title="([^"]+)"[^>]*?href="([^"]+)"/g)].map(([, name = "", url = ""]) => ({
    id: name,
    name,
    maker: "MiniMax",
    url,
  }));
}

export function zaiReleases(markdown: string): LabPage[] {
  const pages = new Map<string, LabPage>();
  for (const [, date = "", name = ""] of markdown.matchAll(/<Update\s+label="([^"]+)"\s+description="\s*([^"]+?)\s*"/g))
    if (!pages.has(name))
      pages.set(name, { id: name, name, maker: "Z.ai", url: `https://docs.z.ai/release-notes/new-released#${date}` });
  return [...pages.values()];
}

/** The index names a page once per section it sits in, so a quickstart can appear twice. */
export function kimiQuickstarts(index: string): LabPage[] {
  const pages = new Map<string, LabPage>();
  for (const [, name = "", url = ""] of index.matchAll(
    /\[([^\]]+)\]\((https:\/\/[^)\s]+\/guide\/kimi-[a-z0-9-]+-quickstart)(?:\.md)?\)/g,
  ))
    if (!pages.has(url)) pages.set(url, { id: url, name, maker: "Moonshot", url });
  return [...pages.values()];
}

/**
 * Xiaomi's announcements, from the news section of its documentation index.
 *
 * The index also carries "Previous News", an archive going back to 2025 that would arrive in full
 * the first time this is read, and every API and FAQ page besides. Only `/news/latest/` is what the
 * lab is saying now.
 */
export function xiaomiNews(index: string): LabPage[] {
  const pages = new Map<string, LabPage>();
  for (const [, name = "", url = ""] of index.matchAll(
    /\[([^\]]+)\]\((https:\/\/[^)\s]+\/docs\/news\/latest\/[^)\s]+?)(?:\.md)?\)/g,
  )) {
    // The index links the markdown behind each post; a reader wants the page it is rendered on.
    const page = url.replace("/static/docs/", "/docs/en-US/");
    if (!pages.has(page)) pages.set(page, { id: page, name, maker: "Xiaomi", url: page });
  }
  return [...pages.values()];
}

const PARSERS: Record<LabPageSource, (body: string) => LabPage[]> = {
  "qwen-blog": qwenPosts,
  "minimax-release-notes": minimaxReleases,
  "kimi-docs": kimiQuickstarts,
  "zai-release-notes": zaiReleases,
  "xiaomi-news": xiaomiNews,
};

export async function collectLabPages(source: LabPageSource, request: Fetch = fetch): Promise<Collection> {
  const url = URLS[source];
  const body = await fetchText(url, { "user-agent": "Mozilla/5.0" }, request);
  const records = PARSERS[source](body);
  if (!records.length) throw new Error(`${LAB_PAGE_SOURCES[source]}'s pages list no model`);
  return {
    source,
    stream: "github",
    url,
    raw: records
      .map((record) => record.id)
      .sort()
      .join("\n"),
    records,
  };
}
