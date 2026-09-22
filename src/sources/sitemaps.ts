import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Pages about a model, read from the labs' sitemaps. A page is listed when it is built, and a lab
 * builds the launch page before it links it: `claude-opus-5-5` was in anthropic.com's routes on
 * 2026-09-22 with no link to it, and DeepMind's model cards go up under `/models/model-cards/` ahead
 * of the post. Only a path whose last part starts with a model's name, or says it introduces one, is
 * kept; the rest of a sitemap is careers and customer stories.
 */
const SITEMAPS: readonly { url: string; maker: string; pages?: RegExp }[] = [
  { url: "https://openai.com/sitemap.xml/page/", maker: "OpenAI" },
  { url: "https://openai.com/sitemap.xml/release/", maker: "OpenAI" },
  { url: "https://openai.com/sitemap.xml/product/", maker: "OpenAI" },
  { url: "https://openai.com/sitemap.xml/research/", maker: "OpenAI" },
  { url: "https://deepmind.google/sitemap.xml", maker: "Google" },
  { url: "https://www.anthropic.com/sitemap.xml", maker: "Anthropic" },
  // Xiaomi's model pages were in its sitemap on 2026-09-22 under `/models/zh-CN/mimo-v2.6-pro`.
  { url: "https://mimo.mi.com/sitemap.xml", maker: "Xiaomi" },
  // Z.ai's docs give each model a guide page: `/guides/llm/glm-5.3`.
  { url: "https://docs.z.ai/sitemap.xml", maker: "Z.ai" },
  // Meta has no sitemap to read, but its blog's front page is plain HTML, and Muse launches are
  // named without a version: "introducing-muse-spark-meta-model-api".
  { url: "https://ai.meta.com/blog/", maker: "Meta", pages: /(?:^|-)(?:muse|llama)(?:-|$)/ },
];

const MODEL_PAGE =
  /^(?:introducing-|previewing-|announcing-)?(?:gpt|o\d|sora|codex|gemini|gemma|veo|imagen|lyria|claude|opus|sonnet|haiku|mythos|fable|mimo|glm)(?:-[a-z]+)*-v?\d[a-z0-9.-]*$/;

/** Words that make a page a story about a model rather than the model's own: "gpt-5-6-in-kiro". */
const STORY_WORDS =
  /-(?:in|for|and|the|to|with|of|on|at|brings|helping|lowers|new|more|model|era|api|apps|updates|release|contributions|discovery|bounty|fine|preferred|availability|advancing|safe)(?:-|$)/;

export function modelPages(xml: string, pattern?: RegExp): string[] {
  const pages = new Set<string>();
  const links = pattern ? xml.matchAll(/href="(https:\/\/[^"]+)"/g) : xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g);
  for (const [, loc = ""] of links) {
    const url = new URL(loc);
    const last = url.pathname.replace(/\/$/, "").split("/").at(-1) ?? "";
    if (
      (pattern ? pattern.test(last) && !url.search : MODEL_PAGE.test(last) && !STORY_WORDS.test(last)) ||
      (url.pathname.includes("/model-cards/") && /\d/.test(last))
    )
      pages.add(`${url.origin}${url.pathname.replace(/\/$/, "")}`);
  }
  return [...pages];
}

/** The sources, one per lab, so each is first-party to the vendor whose pages it lists. */
export const SITEMAP_SOURCES = {
  "openai-sitemap": "OpenAI",
  "deepmind-sitemap": "Google",
  "anthropic-sitemap": "Anthropic",
  "xiaomi-sitemap": "Xiaomi",
  "zai-sitemap": "Z.ai",
  "meta-blog": "Meta",
} as const;

export async function collectLabSitemap(
  source: keyof typeof SITEMAP_SOURCES,
  request: Fetch = fetch,
): Promise<Collection> {
  const maker = SITEMAP_SOURCES[source];
  const sitemaps = SITEMAPS.filter((sitemap) => sitemap.maker === maker);
  const records = new Map<string, { id: string; name: string; maker: string; url: string }>();
  for (const sitemap of sitemaps) {
    const xml = await fetchText(sitemap.url, { "user-agent": "Mozilla/5.0" }, request);
    if (!xml.includes(sitemap.pages ? "href=" : "<loc>")) throw new Error(`${sitemap.url} is not a sitemap`);
    for (const url of modelPages(xml, sitemap.pages))
      records.set(url, { id: url, name: url.split("/").at(-1) ?? url, maker, url });
  }
  if (!records.size) throw new Error(`${maker}'s sitemap lists no model page`);
  return {
    source,
    stream: "github",
    url: sitemaps[0]?.url ?? "",
    raw: [...records.keys()].sort().join("\n"),
    records: [...records.values()],
  };
}
