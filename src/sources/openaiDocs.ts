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
import { modelIdInField, modelIdsInText } from "./modelMentions.js";

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

/** A row of any table on the page, as its cells. */
const TABLE_ROW = /^\|(.+)\|\s*$/;
/** The dashes under a header, which are a row of the table and not a row of it. */
const RULE_CELL = /^:?-{2,}:?$/;
/** A heading of the page, which is what the table under it is called. */
const HEADING = /^#{2,}\s*(.+?)\s*$/;
const DOLLARS = /\$\s*([\d.]+)/;

/**
 * The processing modes OpenAI prices the same model in.
 *
 * They are not headings. The page states the mode as a bare line above the table -- `Standard`,
 * then `### Pricing Table data`, then `Batch`, then `### Pricing Table data` again -- so the
 * heading alone cannot tell two of them apart: `### Grouped Pricing Table data` appears eight times
 * in one answer and `### Pricing Table data` three. Reading only the heading kept the first of each
 * and dropped the rest, which is how the Batch price of every fine-tuned model was missing.
 */
const PRICE_MODES = new Set(["Standard", "Batch", "Flex", "Fast", "Ultrafast", "Priority"]);

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
 * The models a showcase entry states it was built with, which it states as a list of its own.
 *
 * The list ends at the full stop that ends the sentence, which is not every full stop in it: a
 * version carries one, and reading to the first of them turned `Models: gpt-5.5, gpt-image-2.`
 * into `gpt-5`.
 */
const TAGGED_MODELS = /(?:^|[.\s])Models:\s*([a-z0-9.,\s-]+?)(?=\.(?:\s|$)|$)/;

/**
 * The models a tagged entry names: the ones it declares, and the ones it only mentions.
 *
 * The showcase writes `Models: gpt-5.5, gpt-image-2.` after the description, so those ids are a
 * field and need none of the guessing the prose rule does -- which is the difference between
 * seeing the `gpt-image-2` on 2026-10-02's `arcade-landing-page` entry and seeing only the
 * `gpt-5.5` beside it.
 *
 * The declaration is not always there, so it is read as well as the sentences rather than instead
 * of them. Three projects of that day's seventy-three -- `e-commerce-website`,
 * `real-estate-data-viz`, `turn-based-rpg` -- name a model in the description and declare nothing,
 * and reading only the field dropped all three.
 */
function taggedModels(title: string, summary: string): Set<string> {
  const models = new Set(modelIdsInText(`${title} ${summary}`).keys());
  for (const cell of (TAGGED_MODELS.exec(summary)?.[1] ?? "").split(",")) {
    const named = modelIdInField(cell);
    if (named) models.add(named.model);
  }
  return models;
}

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
    const models = index.tagged ? taggedModels(title, summary) : new Set(modelIdsInText(`${title} ${summary}`).keys());
    if (!models.size) continue;
    seen.add(path);
    records.push({
      id: path,
      name: title || path,
      url,
      maker: "OpenAI",
      source: "documentation",
      ...(summary ? { summary } : {}),
      ...(index.tagged ? { models: [...models].sort() } : {}),
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

/** One priced row: which table it was in, which cell of it named the model, and the figures. */
type PricedRow = { heading: string; mode: string; columns: readonly string[]; cells: readonly string[] };

/**
 * The priced rows of the page, each carrying the table it belongs to.
 *
 * A table is read through its own header rather than by position: the specialized, ChatGPT and
 * embedding tables are `Category | Model | Input | Cached input | Output`, and taking the first
 * cell for the model there named the group -- `Codex`, `Life Sciences`, `Search` -- and skipped
 * `gpt-5.3-codex`, `gpt-rosalind-research` and `gpt-5-search-api` entirely.
 */
function pricedRows(markdown: string): PricedRow[] {
  const rows: PricedRow[] = [];
  let heading = "Pricing";
  let mode = "";
  /** Whether the mode in hand has already priced a table, and so belongs to no later one. */
  let spent = false;
  let columns: readonly string[] = [];
  for (const line of markdown.split("\n")) {
    const text = line.trim();
    const titled = HEADING.exec(text);
    if (titled) {
      heading = titled[1] ?? heading;
      continue;
    }
    if (PRICE_MODES.has(text)) {
      mode = text;
      spent = false;
      continue;
    }
    const row = TABLE_ROW.exec(text);
    if (!row) continue;
    const cells = (row[1] ?? "").split("|").map((cell) => cell.trim());
    if (cells.some((cell) => RULE_CELL.test(cell))) continue;
    // A table states its columns before it states a price, so a row without one is the header.
    if (!DOLLARS.test(text)) {
      columns = cells;
      /**
       * A mode is stated for the table that follows it and for no other. The GPT-Live session
       * table states none, and carrying the last one seen priced its minute as `Ultrafast`.
       */
      if (spent) mode = "";
      continue;
    }
    spent = true;
    rows.push({ heading, mode, columns, cells });
  }
  return rows;
}

/** The cell of a row that the table says holds the model, or the first one when it does not say. */
function namedCell(row: PricedRow, name: RegExp): string | null {
  const at = row.columns.findIndex((column) => name.test(column));
  return at < 0 ? null : (row.cells[at] ?? null);
}

export function parseOpenAIPricing(markdown: string): Collection {
  const records = new Map<string, RecordData>();
  let rows = 0;
  for (const row of pricedRows(markdown)) {
    const named = modelIdInField(namedCell(row, /^model$/i) ?? row.cells[0] ?? "");
    // Every table on this page has rows that price a tool rather than a model.
    if (!named) continue;
    const prices: Record<string, number> = {};
    for (const [index, cell] of row.cells.entries()) {
      const dollars = DOLLARS.exec(cell);
      if (dollars) prices[row.columns[index] ?? `column ${index + 1}`] = Number(dollars[1]);
    }
    if (!Object.keys(prices).length) continue;
    rows++;
    /**
     * One model is priced in several tables and they move apart, so what separates them has to be
     * in the id: the mode it is processed in, the modality the row prices, and the ceiling or the
     * agreement a parenthesised row carries. On 2026-10-02 this told 221 rows apart where the
     * heading alone told 84, and the four it still could not separate were tool rows.
     */
    const modality = namedCell(row, /^modality$/i);
    /**
     * The heading is the name of a component in OpenAI's build -- `Grouped Pricing Table data` --
     * so it separates rows well and reads badly. It stays in the id and out of what is stored:
     * what an operator needs is the mode, the modality and the ceiling, and for the one table that
     * states none of them the heading is all there is.
     */
    const tier = [row.mode, modality, named.variant].filter(Boolean).join(" / ") || row.heading;
    const id = `${[row.heading, row.mode, modality, named.variant].filter(Boolean).join(" / ")}:${named.model}`;
    if (!records.has(id))
      records.set(id, {
        id,
        name: named.model,
        url: OPENAI_PRICING_URL,
        maker: "OpenAI",
        model: named.model,
        tier,
        prices,
      });
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
