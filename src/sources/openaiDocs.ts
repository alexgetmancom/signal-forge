/**
 * Two more pages of OpenAI's developer site, read for what they say before anyone announces it.
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
const OPENAI_PRICING_FETCH_URL = "https://developers.openai.com/api/docs/pricing.md";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";

/** An entry of the index: a title, the page's Markdown twin, and the sentence the site gives it. */
const DOCS_ENTRY = /^-\s*\[([^\]]+)\]\((https:\/\/developers\.openai\.com\/api\/docs\/([^)]+?)\.md)\)\s*:?\s*(.*)$/gim;

/** A price table row: the model in the first cell, and a dollar figure in at least one of the rest. */
const PRICE_ROW = /^\|\s*([a-z0-9][a-z0-9.-]*)\s*\|(.+)\|\s*$/gim;
/** The header above a price table, which is what its columns are called. */
const HEADER_ROW = /^\|\s*Model\s*\|(.+)\|\s*$/gim;
const SECTION = /^##+\s*(.+?)\s*$/gm;
const DOLLARS = /\$\s*([\d.]+)/;

export function parseOpenAIDocsIndex(markdown: string): Collection {
  const records: RecordData[] = [];
  const seen = new Set<string>();
  let entries = 0;
  for (const match of markdown.matchAll(DOCS_ENTRY)) {
    entries++;
    const path = (match[3] ?? "").toLowerCase();
    const title = (match[1] ?? "").trim();
    const summary = (match[4] ?? "").trim();
    if (!path || seen.has(path)) continue;
    // A guide is a sighting only when it names a model; the rest of the index is the API's manual.
    if (!modelIdsInText(`${title} ${summary}`).size) continue;
    seen.add(path);
    records.push({
      id: path,
      name: title || path,
      url: `${OPENAI_DOCS_URL}/${path}`,
      maker: "OpenAI",
      source: "documentation",
      ...(summary ? { summary } : {}),
    });
  }
  // An index this parser can no longer read looks exactly like a site that documents nothing.
  if (!entries) throw new Error("OpenAI documentation index listed no page");
  return { source: "openai-docs-index", stream: "pages", url: OPENAI_DOCS_URL, raw: [...seen].sort(), records };
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
    raw: markdown.length,
    confirmChanges: true,
    records: [...records.values()],
  };
}

export async function collectOpenAIDocsIndex(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIDocsIndex(await fetchText(OPENAI_DOCS_INDEX_URL, {}, request, undefined, cache));
}

export async function collectOpenAIPricing(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseOpenAIPricing(await fetchText(OPENAI_PRICING_FETCH_URL, {}, request, undefined, cache));
}
