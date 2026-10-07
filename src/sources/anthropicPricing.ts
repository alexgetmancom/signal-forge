/**
 * What Anthropic charges for its own models, in Anthropic's own words.
 *
 * Every other price this service holds is a reseller's: a gateway quotes what the gateway charges,
 * and it arrives when the gateway gets round to listing. Measured on the Claude Haiku 5.5 launch of
 * 2026-10-07, that was twenty-two minutes after the model itself -- the maker's API answered at
 * 17:51 and the first price anywhere appeared at 18:13. For the three Claude 5.5 releases before
 * this source existed, no card carried a price at all.
 *
 * `/v1/models` does not price anything, so this is the documentation table instead, fetched as the
 * markdown the site publishes beside the page. The first column is the display name, which is the
 * same string `/v1/models` answers with under `display_name`, so a row joins to a model by name
 * without a table of our own.
 *
 * Only the model table is read. The page prices eight other things -- cloud platforms, batch, fast
 * mode, managed agents -- and each would re-price a model this already named, under a different
 * number, with nothing in the record to say which of them a reader is looking at.
 */

import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
/**
 * Asked of the origin that answers, not the one that is advertised.
 *
 * `docs.claude.com/en/docs/about-claude/pricing.md` is the address in everybody's links and it is a
 * redirect to this one. `fetchText` refuses a redirect that changes origin -- a redirect is how a
 * source is quietly pointed at somebody else's content -- so following it is not something to
 * loosen for one page.
 */
const ANTHROPIC_PRICING_FETCH_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";

/**
 * The column headings this reads, and the key each is stored under.
 *
 * The keys are the ones `prices()` already labels, so a rate from here reads on a card exactly as
 * the same rate from a gateway does. The sheet is quoted in dollars per million tokens, which is
 * the unit `priceUnitForSource` records for this source -- the number is stored as the page wrote
 * it and converted where it is read, as everywhere else.
 */
const COLUMNS: { match: RegExp; key: string }[] = [
  { match: /^base input tokens$/i, key: "input" },
  { match: /^output tokens$/i, key: "output" },
  { match: /^5m cache writes$/i, key: "input_cache_write" },
  { match: /^1h cache writes$/i, key: "input_cache_write_1h" },
  { match: /^cache hits and refreshes$/i, key: "input_cache_read" },
];

/** `$12.50 / MTok` is 12.5, and `$2 / MTok<sup>3</sup>` is 2: a footnote marker is not a price. */
function dollars(cell: string): number | null {
  const found = /\$\s*([\d,]+(?:\.\d+)?)/.exec(cell);
  if (!found) return null;
  const amount = Number(found[1]?.replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

/** `[limited availability](https://…)` is two words and a URL; only the words are the name's. */
function plain(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The model a row prices, and the condition the row puts on it.
 *
 * Anthropic qualifies a name three ways in the same column: availability ("limited availability"),
 * lifecycle ("retired, except on Bedrock and Google Cloud") and the prompt length a rate applies to
 * ("for prompts up to 100,000 tokens"). All three are parenthesised and none of them is part of the
 * model's name, so the name is what stands before the bracket and the bracket is kept beside it.
 */
function named(cell: string): { name: string; qualifier: string | null } | null {
  const text = plain(cell);
  if (!text || !/^claude\b/i.test(text)) return null;
  const split = /^([^(]+?)\s*\(([^)]*)\)\s*$/.exec(text);
  const name = (split?.[1] ?? text).trim();
  return name ? { name, qualifier: split?.[2]?.trim() || null } : null;
}

/**
 * The id a row is filed under, spelled the way the maker's own API spells it.
 *
 * `/v1/models` answers `claude-haiku-5-5` for "Claude Haiku 5.5", and a row that cannot be found
 * under that id is a price nothing will ever read. The dot folds into the dash here for the same
 * reason `spelling` folds it there.
 */
function identifier(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** The rows of the table under `## Model pricing`, and nothing from the eight tables after it. */
function modelTable(markdown: string): string[] {
  const section = /^##\s+Model pricing\s*$/m.exec(markdown);
  if (!section) throw new SourceError("missing-content", "Anthropic pricing has no model table");
  const after = markdown.slice(section.index + section[0].length);
  const next = /^##\s+/m.exec(after);
  return (next ? after.slice(0, next.index) : after).split("\n").filter((line) => line.trim().startsWith("|"));
}

export function parseAnthropicPricing(markdown: string): Collection {
  const lines = modelTable(markdown);
  const heading = lines[0];
  if (!heading) throw new SourceError("missing-content", "Anthropic pricing table has no heading row");
  const columns = cells(heading).map((column) => plain(column));
  const keys = columns.map((column) => COLUMNS.find((known) => known.match.test(column))?.key ?? null);
  // A table that still has rows but no column this knows is a reshaped page, not a free model: read
  // on, it would store every Claude model with an empty rate sheet and announce a price removal.
  if (!keys.some(Boolean))
    throw new SourceError("schema", "Anthropic pricing table named no column this reads prices from");

  const records = new Map<string, RecordData>();
  for (const line of lines.slice(1)) {
    const row = cells(line);
    // The alignment row under the heading: `| :--- | :--- |`.
    if (row.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const subject = named(row[0] ?? "");
    if (!subject) continue;
    const pricing: Record<string, number> = {};
    for (const [index, cell] of row.entries()) {
      const key = keys[index];
      const amount = key ? dollars(cell) : null;
      if (key && amount !== null) pricing[key] = amount;
    }
    if (!Object.keys(pricing).length) continue;
    const id = identifier(subject.name);
    /**
     * A model priced in bands keeps the first band as its price and the rest beside it.
     *
     * Claude Haiku 5.5 is two rows -- up to 100,000 tokens and over -- five times apart. Filed as
     * two records they would both answer to the same name, and which of them lent a launch card its
     * price would be whichever the database handed back first. The first row is the rate a reader
     * meets, and the others are a sheet: `prices()` already knows not to print one as a rate.
     */
    const held = records.get(id);
    if (held) {
      const bands = (held.bands as Record<string, unknown>) ?? {};
      if (subject.qualifier) bands[subject.qualifier] = pricing;
      held.bands = bands;
      continue;
    }
    records.set(id, {
      id,
      name: subject.name,
      maker: "Anthropic",
      model: id,
      url: ANTHROPIC_PRICING_URL,
      pricing,
      ...(subject.qualifier ? { qualifier: subject.qualifier } : {}),
    });
  }
  // Every Claude model losing its price at once is a page that moved, not a sheet that emptied.
  if (!records.size) throw new SourceError("missing-content", "Anthropic pricing named no priced model");
  return {
    source: "anthropic-pricing",
    stream: "api-models",
    url: ANTHROPIC_PRICING_URL,
    // The models priced, so a snapshot answers what the table held rather than how long it was.
    raw: [...records.keys()].sort(),
    confirmChanges: true,
    records: [...records.values()],
  };
}

export async function collectAnthropicPricing(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseAnthropicPricing(await fetchText(ANTHROPIC_PRICING_FETCH_URL, {}, request, undefined, cache));
}
