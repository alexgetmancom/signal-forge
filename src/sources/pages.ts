import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

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
  vendor: string;
  sitemap: string;
  /**
   * Sections that never carry product news. This is a list of what to ignore rather than a list of
   * what to keep, so a section a vendor invents for something new is collected the day it appears.
   * An entry is a leading path, so `docs/de` ignores one locale of a documentation tree whose first
   * segment is always `docs`.
   */
  ignoreSections?: readonly string[];
};

/** The languages Anthropic translates its documentation into, besides English. */
const CLAUDE_TRANSLATIONS = ["de", "es", "fr", "id", "it", "ja", "ko", "pt-BR", "ru", "zh-CN", "zh-TW"];

export const WATCHED_SITES: readonly WatchedSite[] = [
  {
    id: "openai",
    name: "OpenAI",
    vendor: "OpenAI",
    sitemap: "https://openai.com/sitemap.xml",
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
    sitemap: "https://ai.google.dev/sitemap.xml",
    ignoreSections: ["competition", "edu", "responsible-ai", "terms"],
  },
  // Most of this sitemap is the billing console; what is left is the model and pricing pages.
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
    ignoreSections: ["de", "es", "fr", "id", "it", "ja", "ko", "pt", "ru", "zh-CN", "zh-TW"],
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

/** One collection follows at most this many child sitemaps of an index, newest sections first. */
const MAX_CHILD_SITEMAPS = 12;
const MAX_PAGES = 4000;

const locations = z.array(z.object({ loc: z.union([z.string(), z.number()]) }).passthrough());

function parseXml(payload: string): { urls: string[]; children: string[] } {
  const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => name === "url" || name === "sitemap" });
  const document = parser.parse(payload) as Record<string, unknown>;
  const read = (value: unknown): string[] => {
    const entries = value && typeof value === "object" ? (value as { sitemap?: unknown; url?: unknown }) : {};
    const parsed = locations.safeParse(entries.sitemap ?? entries.url ?? []);
    return parsed.success ? parsed.data.map((entry) => String(entry.loc).trim()).filter(Boolean) : [];
  };
  // An empty <urlset/> parses to an empty string. That is a sitemap that listed nothing, which the
  // caller reports as a failed read, and not a document of an unknown shape.
  if ("sitemapindex" in document) return { urls: [], children: read(document.sitemapindex) };
  if ("urlset" in document) return { urls: read(document.urlset), children: [] };
  throw new Error("Sitemap contained neither a urlset nor a sitemap index");
}

/** A slug is a filename; a reader wants the name of the page. */
function titleFor(path: string): string {
  const slug = path.split("/").filter(Boolean).at(-1) ?? path;
  const words = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
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
  const ignored = site.ignoreSections?.some((entry) =>
    entry.split("/").every((part, index) => segments[index] === part),
  );
  if (ignored) return null;
  return {
    id: path,
    name: `${site.name}: ${titleFor(path)}`,
    url: `${url.origin}${path}`,
    section: section || "root",
    path,
    maker: site.vendor,
  };
}

export function parseSitemap(payloads: string[], site: WatchedSite): Collection {
  const seen = new Map<string, RecordData>();
  for (const payload of payloads)
    for (const location of parseXml(payload).urls) {
      const record = pageRecord(location, site);
      if (record && !seen.has(record.id)) seen.set(record.id, record);
    }
  // An empty sitemap is a failed read of a site that certainly still has pages.
  if (!seen.size) throw new Error(`Sitemap for ${site.name} listed no usable pages`);
  return {
    source: `pages:${site.id}`,
    stream: "pages",
    url: site.sitemap,
    raw: { pages: seen.size },
    records: [...seen.values()].slice(0, MAX_PAGES),
  };
}

export async function collectSitePages(
  site: WatchedSite,
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  const headers = { accept: "application/xml" };
  const root = await fetchText(site.sitemap, headers, request, undefined, cache);
  const { children } = parseXml(root);
  if (!children.length) return parseSitemap([root], site);
  const payloads: string[] = [];
  for (const child of children.slice(0, MAX_CHILD_SITEMAPS))
    payloads.push(await fetchText(child, headers, request, undefined, cache));
  return parseSitemap(payloads, site);
}
