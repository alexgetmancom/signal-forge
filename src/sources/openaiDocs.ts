/**
 * The indexes and the price table of OpenAI's developer site, read for what they say before
 * anyone announces it.
 *
 * The documentation index lists every guide the site publishes, with the sentence the site gives
 * it. A model ships with its guides -- "Upgrading to GPT-5.6 Sol" is a page, and the GPT-6 guide's
 * own description named GPT-6.1 Sol -- so a guide that names a model nobody here has heard of is
 * the same kind of tell as a model page that answers. Only the entries that name a model are kept:
 * the index is 43 KB of API documentation, and "Error codes" appearing is not news.
 *
 * The price table is the other. It is the maker's own word on what a model costs, which no
 * catalogue is: a reseller quotes what it charges. A new row is a model priced before it is
 * announced, and a changed row is a price cut, which for a reader paying for Codex is the news.
 */

import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";
import { modelIdsInText } from "./modelMentions.js";

const OPENAI_DOCS_INDEX_URL = "https://developers.openai.com/api/docs/llms.txt";
const OPENAI_DOCS_URL = "https://developers.openai.com/api/docs";
const OPENAI_LEARN_INDEX_URL = "https://developers.openai.com/learn/llms.txt";
const OPENAI_LEARN_URL = "https://developers.openai.com/learn";
const OPENAI_COOKBOOK_URL = "https://developers.openai.com/cookbook";
const OPENAI_SHOWCASE_INDEX_URL = "https://developers.openai.com/showcase/llms.txt";
const OPENAI_SHOWCASE_URL = "https://developers.openai.com/showcase";
const OPENAI_PRICING_FETCH_URL = "https://developers.openai.com/api/docs/pricing.md";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";

/** An entry of an index: a title, a page on the site, and the sentence the site gives it. */
const INDEX_ENTRY = /^-\s*\[([^\]]+)\]\((https:\/\/developers\.openai\.com\/[^)\s]+?)\)\s*:?\s*(.*)$/gim;

/** An index's own bulk export, which is every page it lists in one body rather than a page. */
const BULK_EXPORT = /\.(?:txt|json|xml|ya?ml|csv)$/i;

/** A price table row: the model in the first cell, and a dollar figure in at least one of the rest. */
const PRICE_ROW = /^\|\s*([a-z0-9][a-z0-9.-]*)\s*\|(.+)\|\s*$/gim;
/** The header above a price table, which is what its columns are called. */
const HEADER_ROW = /^\|\s*Model\s*\|(.+)\|\s*$/gim;
const SECTION = /^##+\s*(.+?)\s*$/gm;
const DOLLARS = /\$\s*([\d.]+)/;

/** One `llms.txt` of the developer site: which pages it lists, and how to read each entry. */
type SiteIndex = {
  source: string;
  /** Entries under these prefixes are this index's own pages; everything else it links is somebody else's. */
  prefixes: readonly string[];
  url: string;
  /**
   * Whether to keep the model ids the entry names as a field of its own. The showcase says
   * "Models: gpt-6, gpt-image-2" in as many words, so its records carry the tags and a project
   * retagged to a newer model is a change rather than a new page.
   */
  tagged?: true;
};

/**
 * The pages of one index that name a model, as records.
 *
 * Only entries under the index's own prefixes are kept, and an index owns the paths nothing else
 * here reads. The learn index is mostly other people's addresses: eighteen GitHub repositories
 * that are read as repositories elsewhere, fifty YouTube and webinar recordings, and the whole
 * `platform.openai.com` guide set. It also lists `api/docs/guides/...`, which the documentation
 * index already carries -- kept here too, the same guide would arrive twice under two ids from two
 * sources, and the second one would read as a page that had just appeared.
 */
function parseSiteIndex(markdown: string, index: SiteIndex): Collection {
  const records: RecordData[] = [];
  const seen = new Set<string>();
  let entries = 0;
  for (const match of markdown.matchAll(INDEX_ENTRY)) {
    entries++;
    const href = (match[2] ?? "").trim();
    const prefix = index.prefixes.find((candidate) => href.startsWith(`${candidate}/`));
    if (!prefix) continue;
    const title = (match[1] ?? "").trim();
    const summary = (match[3] ?? "").trim();
    // A page and its Markdown twin are one page: the learn index lists `learn/docs-mcp.md` and
    // `learn/docs-mcp`, and they are not two guides.
    const rest = href.slice(prefix.length + 1).replace(/\.md$/i, "");
    const url = `${prefix}/${rest}`;
    // A bulk export is not a page. The learn index links `llms-full.txt`, every guide it already
    // lists concatenated into one body, which names every model the whole site mentions on the day
    // it is read. Only these extensions are refused, because a path is also where a version lives:
    // `image-gen-1.5-prompting_guide` is a guide to gpt-image-1.5 and not a file called `5`.
    if (!rest || BULK_EXPORT.test(rest)) continue;
    // The id is the page's path under the index it belongs to, not its title, so a retitled page
    // stays the page it was. An index that reaches outside its own base keeps the rest of the path.
    const path = (URL.parse(url)?.pathname ?? "")
      .replace(new RegExp(`^${URL.parse(index.url)?.pathname ?? ""}/`), "")
      .replace(/^\//, "")
      .toLowerCase();
    if (!path || seen.has(path)) continue;
    // A page is a sighting only when it names a model; the rest of an index is the site's manual.
    const models = modelIdsInText(`${title} ${summary}`);
    if (!models.size) continue;
    seen.add(path);
    records.push({
      id: path,
      name: title || path,
      url,
      maker: "OpenAI",
      source: "documentation",
      ...(summary ? { summary } : {}),
      ...(index.tagged ? { models: [...models.keys()].sort() } : {}),
    });
  }
  // An index this parser can no longer read looks exactly like a site that documents nothing.
  if (!entries) throw new Error(`${index.source} listed no page`);
  return { source: index.source, stream: "pages", url: index.url, raw: [...seen].sort(), records };
}

export function parseOpenAIDocsIndex(markdown: string): Collection {
  return parseSiteIndex(markdown, {
    source: "openai-docs-index",
    prefixes: [OPENAI_DOCS_URL],
    url: OPENAI_DOCS_URL,
  });
}

/**
 * The learn index: the guides and walkthroughs written for a model, rather than its reference.
 *
 * A use-case page is written against whatever model is current when it is written, and on
 * 2026-09-29 eight of them named a model in prose -- `gpt-6.1-sol` on four, `gpt-5.6-terra` on the
 * iOS page -- while this service read only `api/docs/llms.txt` and saw none of them. The cookbook
 * is listed by the same index and is the same kind of page: "GPT-5.2 Prompting Guide" is a model's
 * name in a title, written by the people who shipped it.
 */
export function parseOpenAILearnIndex(markdown: string): Collection {
  return parseSiteIndex(markdown, {
    source: "openai-learn-index",
    prefixes: [OPENAI_LEARN_URL, OPENAI_COOKBOOK_URL],
    url: OPENAI_LEARN_URL,
  });
}

/**
 * The showcase index: what OpenAI says its own models built, with the models named as tags.
 *
 * This is the one index of the three that states the model instead of mentioning it, so it is the
 * one read for its tags. Twenty of the seventy-three projects carried `gpt-6` on 2026-09-29, and a
 * tag arrives here on the day a project is published rather than on the day a model is announced.
 */
export function parseOpenAIShowcaseIndex(markdown: string): Collection {
  return parseSiteIndex(markdown, {
    source: "openai-showcase-index",
    prefixes: [OPENAI_SHOWCASE_URL],
    url: OPENAI_SHOWCASE_URL,
    tagged: true,
  });
}

export function parseOpenAIPricing(markdown: string): Collection {
  const sections = [...markdown.matchAll(SECTION)].map((match) => ({
    at: match.index ?? 0,
    name: (match[1] ?? "").trim(),
  }));
  const sectionAt = (index: number): string =>
    sections.filter((section) => section.at < index).at(-1)?.name ?? "Pricing";
  /**
   * What the columns of each table are called, so a card can say "short context input" and not the
   * fourth cell of a row. Tables differ -- the grouped one prices by context length and the flex one
   * does not -- so the nearest header above a row is the one that names it.
   */
  const headers = [...markdown.matchAll(HEADER_ROW)].map((match) => ({
    at: match.index ?? 0,
    columns: (match[1] ?? "").split("|").map((cell) => cell.trim()),
  }));
  const columnAt = (index: number, cell: number): string =>
    headers.filter((header) => header.at < index).at(-1)?.columns[cell] ?? `column ${cell + 1}`;
  const records = new Map<string, RecordData>();
  let rows = 0;
  for (const match of markdown.matchAll(PRICE_ROW)) {
    const model = (match[1] ?? "").toLowerCase();
    // The header row and the dashes under it are rows too, and neither names a model.
    if (!modelIdsInText(model).size) continue;
    const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
    const prices: Record<string, number> = {};
    for (const [index, cell] of cells.entries()) {
      const dollars = DOLLARS.exec(cell);
      if (dollars) prices[columnAt(match.index ?? 0, index)] = Number(dollars[1]);
    }
    if (!Object.keys(prices).length) continue;
    rows++;
    // One model is priced in several tables -- standard, batch, priority -- and they move apart.
    const section = sectionAt(match.index ?? 0);
    const id = `${section}:${model}`;
    if (!records.has(id))
      records.set(id, { id, name: model, url: OPENAI_PRICING_URL, maker: "OpenAI", model, tier: section, prices });
  }
  // A table whose shape moved reads as every model losing its price at once, which is not a fact.
  if (!rows) throw new Error("OpenAI pricing named no priced model");
  return {
    source: "openai-pricing",
    stream: "api-models",
    url: OPENAI_PRICING_URL,
    // The rows read, so `snapshot` answers what was priced rather than how long the page was.
    raw: [...records.keys()].sort(),
    confirmChanges: true,
    records: [...records.values()],
  };
}

export async function collectOpenAIDocsIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIDocsIndex(await fetchText(OPENAI_DOCS_INDEX_URL, {}, request, undefined, cache));
}

export async function collectOpenAILearnIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAILearnIndex(await fetchText(OPENAI_LEARN_INDEX_URL, {}, request, undefined, cache));
}

export async function collectOpenAIShowcaseIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIShowcaseIndex(await fetchText(OPENAI_SHOWCASE_INDEX_URL, {}, request, undefined, cache));
}

export async function collectOpenAIPricing(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIPricing(await fetchText(OPENAI_PRICING_FETCH_URL, {}, request, undefined, cache));
}
