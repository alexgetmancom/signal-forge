import type { Database } from "bun:sqlite";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { fetchText } from "./http.js";
import type { Vendor } from "./vendors.js";

/**
 * A product page is published before it is announced. A vendor's own sitemap lists every page it
 * serves, so a page appearing there is public evidence that something is being prepared, without
 * guessing at URLs or crawling a site.
 *
 * Only the identity of a page is recorded. A sitemap's `lastmod` moves whenever a template is
 * rebuilt, and keeping it would turn every deploy into a change event about pages that did not
 * change.
 */
export type WatchedSite = {
  id: string;
  name: string;
  vendor: Vendor;
  sitemap: string;
  /**
   * Sections that never carry product news. This is a list of what to ignore rather than a list of
   * what to keep, so a section a vendor invents for something new is collected the day it appears.
   * An entry is a leading path, so `docs/de` ignores one locale of a documentation tree whose first
   * segment is always `docs`.
   */
  ignoreSections?: readonly string[];
  /** A sitemap of megabytes; see `heavy` on a source definition. */
  heavy?: boolean;
};

/** The languages Anthropic translates its documentation into, besides English. */
const CLAUDE_TRANSLATIONS = ["de", "es", "fr", "id", "it", "ja", "ko", "pt-BR", "ru", "zh-CN", "zh-TW"];
const GOOGLE_SITEMAP = "https://ai.google.dev/sitemap.xml";

export const WATCHED_SITES: readonly WatchedSite[] = [
  {
    id: "openai",
    name: "OpenAI",
    vendor: "OpenAI",
    sitemap: "https://openai.com/sitemap.xml",
    // 42 child sitemaps, 14.4 MB of XML between them; +64 MB of permanent high-water on a first
    // read, second only to `google`. See the note there.
    heavy: true,
    // `index` is the newsroom, already read through its feed, and `business` and `events` are
    // partner and conference pages. Every new page this site produced in the week to 2026-09-16 sat
    // in one of the three -- eight "Disrupting malicious uses of AI" reports reached the invited
    // room in one message -- and the site's measured lead over everyone else is 0.1 hours.
    ignoreSections: [
      "policies",
      "form",
      "supply",
      "global-affairs",
      "careers",
      "jobs",
      "brand-stories",
      "index",
      "business",
      "events",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    vendor: "Anthropic",
    sitemap: "https://www.anthropic.com/sitemap.xml",
    ignoreSections: ["legal", "events", "careers", "jobs"],
  },
  {
    id: "xai",
    name: "xAI",
    vendor: "xAI",
    sitemap: "https://x.ai/sitemap.xml",
    ignoreSections: ["bot", "legal", "careers", "jobs"],
  },
  // x.ai carries the newsroom; the API and Grok bot are documented here, and a capability is written
  // up before it is announced: regions, bot computers and bot proxies appeared on 2026-09-15 and
  // 2026-09-16 with nothing here reading them. One language, no locale trees.
  {
    id: "xai-docs",
    name: "xAI Docs",
    vendor: "xAI",
    sitemap: "https://docs.x.ai/sitemap.xml",
    // Billing, quota and account help, which is the console describing itself.
    ignoreSections: ["console/billing", "console/faq", "console/usage"],
  },
  {
    id: "deepmind",
    name: "Google DeepMind",
    vendor: "Google",
    sitemap: "https://deepmind.google/sitemap.xml",
    ignoreSections: ["about", "careers", "jobs"],
  },
  // DeepMind publishes the research; a model becomes usable on the developer site, and a page for
  // a Gemini version appears there before the changelog mentions it.
  {
    id: "google",
    name: "Google AI for Developers",
    vendor: "Google",
    sitemap: GOOGLE_SITEMAP,
    // One child sitemap of 14.7 MB, the largest XML read here. Measured 2026-09-27: reading it the
    // first time in a process raises that process's high-water mark by 192 MB -- a third of what the
    // whole light lane ever claims -- and RSS is never given back, so in a long-lived process that
    // 192 MB is permanent. Collected in a child, which ends.
    heavy: true,
    ignoreSections: ["competition", "edu", "responsible-ai", "terms"],
  },
  // Most of this sitemap is the billing console; what is left is the model and pricing pages.
  // The blog at z.ai/blog is not in it and cannot be listed: on 2026-09-19, and again on 2026-09-27,
  // it had no index, feed or sitemap, and no other page linked a post, so "How GLM Built Its Own
  // Inference Infrastructure" reached us only through Hacker News. An essay can still only arrive
  // that way. A release cannot hide the same way, because the address of its post is the name of the
  // model: `discovery:blog-zai` in probes.ts asks for one by name rather than waiting for a list.
  {
    id: "zai",
    name: "Z.ai",
    vendor: "Z.ai",
    sitemap: "https://z.ai/sitemap.xml",
    ignoreSections: [
      "manage-apikey",
      "team",
      "subscribe",
      "payment",
      "usage-bundle",
      "usage-bundles",
      "contact",
      "consultation",
      "company",
    ],
  },
  // The API reference is where a capability is documented before it is announced: the September
  // 2026 MCP tunnel and usage-report endpoints appeared here first. docs.claude.com redirects to
  // this origin, and the fetcher refuses a cross-origin redirect, so the final address is used.
  {
    id: "claude-docs",
    name: "Claude Docs",
    vendor: "Anthropic",
    sitemap: "https://platform.claude.com/sitemap.xml",
    // Every page is published in twelve languages at once. Only English is read: three new pages on
    // 2026-09-16 reached the invited room as thirty-four cards.
    ignoreSections: [
      "settings",
      "logs",
      "usage",
      "playground",
      ...CLAUDE_TRANSLATIONS.map((locale) => `docs/${locale}`),
    ],
  },
  // A help-centre article is written when a feature is about to reach subscribers. The sitemap
  // carries the same articles in twelve languages; every locale but English is one page repeated.
  {
    id: "claude-support",
    name: "Claude Support",
    vendor: "Anthropic",
    sitemap: "https://support.claude.com/sitemap.xml",
    // Twelve locales of every article in one document: 8 MB of XML, the second largest body read
    // here, and the whole of it parsed to keep the English pages.
    heavy: true,
    ignoreSections: ["de", "es", "fr", "id", "it", "ja", "ko", "pt", "ru", "zh-CN", "zh-TW"],
  },
  // Mistral's newsroom is where a model and a partnership are announced; its API catalogue says
  // nothing until a model is callable. "Mistral X Mozilla" on 2026-09-16 was missed for want of it.
  // `/sitemap.xml` redirects here. The site is published in French and Italian as well.
  {
    id: "mistral",
    name: "Mistral",
    vendor: "Mistral",
    sitemap: "https://mistral.ai/sitemap-index.xml",
    ignoreSections: ["fr", "it", "legal", "careers", "contact", "brand", "about"],
  },
  // Google announces developer-facing model and tooling work here rather than on the product blog.
  // Every entry is a post at the root, so there is no section worth ignoring.
  {
    id: "google-devs",
    name: "Google Developers Blog",
    vendor: "Google",
    sitemap: "https://developers.googleblog.com/sitemap.xml",
  },
];

/**
 * Bounds on a read that has gone wrong, never a sample of a site. Measured 2026-09-17: OpenAI's index
 * lists 39 child sitemaps and the largest sitemap lists 4,442 URLs. A site past either bound fails the
 * read: a truncated catalogue would report the pages beyond the cut as gone, or never see them arrive.
 */
const MAX_CHILD_SITEMAPS = 60;
const MAX_PAGES = 10_000;

/**
 * The `<loc>` entries of a sitemap, and which of the two documents it is.
 *
 * Read by scanning the text rather than by building a tree. Measured 2026-09-27 on
 * ai.google.dev's 14.7 MB sitemap: `XMLValidator.validate` and `XMLParser.parse` together raise a
 * process's high-water mark by 181 MB, against 55 MB for this scan, and a high-water mark is never
 * given back. A sitemap is the one XML document where that trade is free -- every entry is a `<loc>`
 * and nothing else in it is read -- and the scan was checked against the tree on the two largest
 * real documents here before replacing it: 6,195 locations against 6,195, and the sets identical.
 */
const LOC = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return NAMED[String(name).toLowerCase()] ?? whole;
  });
}

type Sitemap = { url: string; modified: string | null };

function parseXml(payload: string): { urls: string[]; sitemaps: Sitemap[] } {
  const root = /<(urlset|sitemapindex)\b/i.exec(payload);
  if (!root) throw new SourceError("schema", "Sitemap contained neither a urlset nor a sitemap index");
  const kind = (root[1] ?? "").toLowerCase();
  // A body cut off mid-transfer is a truncated sitemap, and the pages it does carry are real. It
  // must not be read as one: fewer pages than last time is how a shrunk collection is detected, and
  // a network cut would look like a site that deleted half of itself. The closing tag is the whole
  // of the check -- what a vendor's generator emits is well-formed, and what a proxy returns instead
  // has no root element at all, which the line above catches.
  if (!new RegExp(`</${kind}\\s*>\\s*$`, "i").test(payload.trimEnd()))
    throw new SourceError("protocol", "Sitemap ended mid-document");
  const locations: string[] = [];
  for (const match of payload.matchAll(LOC)) {
    const location = decodeEntities((match[1] ?? "").replace(CDATA, "$1")).trim();
    if (location) locations.push(location);
  }
  if (kind === "urlset") return { urls: locations, sitemaps: [] };
  const sitemaps = [...payload.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap\s*>/gi)].map((match) => {
    const block = match[1] ?? "";
    const location = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(block)?.[1] ?? "";
    const modified = /<lastmod\b[^>]*>([^<]+)<\/lastmod\s*>/i.exec(block)?.[1]?.trim();
    return {
      url: decodeEntities(location.replace(CDATA, "$1")).trim(),
      modified:
        modified && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(modified) && Number.isFinite(Date.parse(modified))
          ? new Date(modified).toISOString()
          : null,
    };
  });
  if (sitemaps.length !== locations.length || sitemaps.some((sitemap) => !sitemap.url))
    throw new SourceError("schema", "Sitemap index contains incomplete entries");
  return { urls: [], sitemaps: sitemaps.sort((a, b) => a.url.localeCompare(b.url)) };
}

/** Google publishes the child file's modification time in its 253-byte index. */
export async function googleSitemapUnchanged(db: Database, request: Fetch = fetch): Promise<boolean> {
  if (!db.query("SELECT 1 FROM live_sources WHERE id='pages:google' AND failures=0 AND last_success IS NOT NULL").get())
    return false;
  const before = readLatestSnapshot(db, "pages:google");
  if (!before) return false;
  const previous = (JSON.parse(before) as { sitemaps?: Sitemap[] }).sitemaps;
  if (!previous?.length) return false;
  const { sitemaps } = parseXml(await fetchText(GOOGLE_SITEMAP, { accept: "application/xml" }, request));
  if (!sitemaps.length || sitemaps.length > MAX_CHILD_SITEMAPS || sitemaps.some((sitemap) => !sitemap.modified))
    return false;
  return JSON.stringify(sitemaps) === JSON.stringify(previous);
}

/** A slug is a filename; a reader wants the name of the page. */
function titleFor(path: string): string {
  const slug = path.split("/").filter(Boolean).at(-1) ?? path;
  // A malformed escape is the vendor's typo, not a reason to stop reading the whole site.
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {}
  const words = decoded.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}

function inIgnoredSection(path: string, site: WatchedSite): boolean {
  const segments = path.split("/").filter(Boolean);
  return Boolean(
    site.ignoreSections?.some((entry) => entry.split("/").every((part, index) => segments[index] === part)),
  );
}

function pageRecord(location: string, site: WatchedSite): RecordData | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return null;
  const segments = path.split("/").filter(Boolean);
  const section = segments[0] ?? "";
  if (inIgnoredSection(path, site)) return null;
  return {
    id: path,
    name: `${site.name}: ${titleFor(path)}`,
    url: `${url.origin}${path}`,
    section: section || "root",
    path,
    maker: site.vendor,
  };
}

export function parseSitemap(payloads: string[], site: WatchedSite, baseline: readonly number[] = []): Collection {
  const seen = new Map<string, RecordData>();
  const silentIds: string[] = [];
  payloads.forEach((payload, index) => {
    for (const location of parseXml(payload).urls) {
      const record = pageRecord(location, site);
      if (!record || seen.has(record.id)) continue;
      seen.set(record.id, record);
      if (baseline.includes(index)) silentIds.push(record.id);
    }
  });
  // An empty sitemap is a failed read of a site that certainly still has pages.
  if (!seen.size) throw new SourceError("empty", `Sitemap for ${site.name} listed no usable pages`);
  if (seen.size > MAX_PAGES)
    throw new SourceError("protocol", `Sitemap for ${site.name} lists more than ${MAX_PAGES} pages`);
  return {
    source: `pages:${site.id}`,
    stream: "pages",
    url: site.sitemap,
    raw: { pages: seen.size },
    records: [...seen.values()],
    forget: (id) => inIgnoredSection(id, site),
    ...(silentIds.length ? { silentIds } : {}),
  };
}

/**
 * Only the first successful read is a baseline; a later shard can carry newly published pages.
 */
export async function collectSitePages(
  site: WatchedSite,
  request: Fetch = fetch,
  cache?: HttpCache,
  initialized = false,
): Promise<Collection> {
  const headers = { accept: "application/xml" };
  const root = await fetchText(site.sitemap, headers, request, undefined, cache);
  const { sitemaps } = parseXml(root);
  if (!sitemaps.length) return parseSitemap([root], site);
  if (sitemaps.length > MAX_CHILD_SITEMAPS)
    throw new SourceError("protocol", `Sitemap for ${site.name} lists more than ${MAX_CHILD_SITEMAPS} child sitemaps`);
  const payloads: string[] = [];
  for (const sitemap of sitemaps) payloads.push(await fetchText(sitemap.url, headers, request, undefined, cache));
  // Only a site read for the first time is a baseline. A child sitemap that appears later is how
  // many sites shard by month or by size, and the pages in a new shard are the new pages; a page
  // that merely moved between shards keeps its id and is not announced again.
  const baseline = initialized ? [] : sitemaps.map((_, index) => index);
  const collection = parseSitemap(payloads, site, baseline);
  return { ...collection, raw: { pages: collection.records.length, sitemaps } };
}
