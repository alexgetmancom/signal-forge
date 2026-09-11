import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { collectSitePages, parseSitemap, WATCHED_SITES } from "../src/sources/pages.js";

const site = WATCHED_SITES[1] as (typeof WATCHED_SITES)[number];

const urlset = (paths: string[], lastmod = "2026-09-11T14:31:54.346Z") =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${paths.map((path) => `<url><loc>https://www.anthropic.com${path}</loc><lastmod>${lastmod}</lastmod></url>`).join("")}
   </urlset>`;

const index = (children: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${children.map((child) => `<sitemap><loc>${child}</loc></sitemap>`).join("")}
   </sitemapindex>`;

test("a sitemap becomes one record per page, named for a reader", () => {
  const collection = parseSitemap([urlset(["/news/claude-opus-5", "/pricing"])], site);
  expect(collection.source).toBe("pages:anthropic");
  expect(collection.stream).toBe("pages");
  expect(collection.records).toEqual([
    {
      id: "/news/claude-opus-5",
      name: "Anthropic: Claude opus 5",
      url: "https://www.anthropic.com/news/claude-opus-5",
      section: "news",
      path: "/news/claude-opus-5",
      maker: "Anthropic",
    },
    {
      id: "/pricing",
      name: "Anthropic: Pricing",
      url: "https://www.anthropic.com/pricing",
      section: "pricing",
      path: "/pricing",
      maker: "Anthropic",
    },
  ]);
});

test("a rebuilt sitemap with new timestamps produces identical records", () => {
  const first = parseSitemap([urlset(["/news/one"], "2026-09-01T00:00:00.000Z")], site);
  const second = parseSitemap([urlset(["/news/one"], "2026-09-11T00:00:00.000Z")], site);
  // Keeping lastmod would turn every template deploy into a change event about unchanged pages.
  expect(second.records).toEqual(first.records);
});

test("the root page and duplicate trailing slashes never become separate pages", () => {
  const collection = parseSitemap([urlset(["/", "/news/one", "/news/one/"])], site);
  expect(collection.records.map((record) => record.id)).toEqual(["/news/one"]);
});

test("an empty or malformed sitemap is a failed read, never a site with no pages", () => {
  expect(() => parseSitemap([urlset([])], site)).toThrow("listed no usable pages");
  expect(() => parseSitemap(["<html>blocked</html>"], site)).toThrow();
});

test("a sitemap index is followed one level and merged without duplicates", async () => {
  const responses: Record<string, string> = {
    "https://www.anthropic.com/sitemap.xml": index([
      "https://www.anthropic.com/sitemap/news.xml",
      "https://www.anthropic.com/sitemap/product.xml",
    ]),
    "https://www.anthropic.com/sitemap/news.xml": urlset(["/news/one", "/shared"]),
    "https://www.anthropic.com/sitemap/product.xml": urlset(["/product/two", "/shared"]),
  };
  const collection = await collectSitePages(site, async (url) => {
    const body = responses[String(url)];
    if (!body) throw new Error(`unexpected request: ${String(url)}`);
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  });
  expect(collection.records.map((record) => record.id)).toEqual(["/news/one", "/shared", "/product/two"]);
});

test("a page appearing is a codename signal; a page leaving is only evidence", () => {
  const event = (kind: Event["kind"]): Event => ({
    id: 1,
    source: "pages:anthropic",
    stream: "pages",
    entity_id: "/news/claude-opus-5",
    kind,
    before_json:
      kind === "new" ? null : JSON.stringify({ id: "/news/claude-opus-5", name: "Anthropic: Claude opus 5" }),
    after_json:
      kind === "removed" ? null : JSON.stringify({ id: "/news/claude-opus-5", name: "Anthropic: Claude opus 5" }),
    detected_at: "2026-09-11T00:00:00.000Z",
  });
  expect(signalClass(event("new"))).toBe("codename");
  expect(signalClass(event("removed"))).toBe("evidence");
});
