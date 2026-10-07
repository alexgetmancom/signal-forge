import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { slug } from "../text.js";
import { attribute, htmlText } from "./html.js";
import { fetchText } from "./http.js";
import { distinctIds } from "./ids.js";

const DEEPSEEK_UPDATES_URL = "https://api-docs.deepseek.com/updates";
const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/?article_id=article_1779470751466_8";
const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

/**
 * DeepSeek's own `/models` grew past `id` and `owned_by` on 2026-09-22, and the read that kept only
 * those two threw the growth away: the response started saying `deepseek-flash` is named
 * `DeepSeek-V4.1-Flash` -- the first-party word on a version six days before anyone reported it --
 * and the comparison body was byte-identical, so no event was raised. Everything the list offers
 * about a model it can be asked for is compared now.
 *
 * `api_capabilities` is the exception: it is a nested, vendor-shaped object, and storing it whole
 * would churn the record on any reshuffle upstream. Its key names are what a new capability shows
 * up as, so the record keeps the sorted keys and not the bodies under them.
 */
const modelsSchema = z.object({
  object: z.literal("list"),
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        owned_by: z.string().min(1),
        name: z.string().min(1).nullish(),
        context_window: z.number().int().positive().nullish(),
        max_output_tokens: z.number().int().positive().nullish(),
        input_modalities: z.array(z.string().min(1)).nullish(),
        output_modalities: z.array(z.string().min(1)).nullish(),
        effort: z
          .object({
            supported_levels: z.array(z.string().min(1)).nullish(),
            default_level: z.string().min(1).nullish(),
          })
          .nullish(),
        api_capabilities: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .min(1),
});

const entrySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)), "Invalid update date"),
  anchor: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  summary: z.string().max(1_200),
});

const entriesSchema = z.array(entrySchema).min(1);

const pricingRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    maker: z.literal("DeepSeek"),
    model: z.string().min(1),
    url: z.url(),
    modelVersion: z.string().nullish(),
    context: z.string().nullish(),
    maxOutput: z.string().nullish(),
    capabilities: z.array(z.string()).default([]),
    pricing: z.record(z.string(), z.number().finite()).default({}),
    concurrencyLimit: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const pricingRecordsSchema = z.array(pricingRecordSchema).min(1);

/** Parse the dated update sections from DeepSeek's official API documentation page. */
export function parseDeepSeekUpdates(html: string): Collection {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (!article) throw new SourceError("missing-content", "DeepSeek changelog article not found");

  const dateHeadings = [...article.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const parsed = dateHeadings.flatMap((heading, index) => {
    const headingText = htmlText(heading[1] ?? "");
    const date = /^Date:\s*(\d{4}-\d{2}-\d{2})$/.exec(headingText)?.[1];
    if (!date || heading.index === undefined) return [];
    const sectionStart = heading.index + heading[0].length;
    const nextHeading = dateHeadings[index + 1];
    const sectionEnd = nextHeading?.index ?? article.length;
    const section = article.slice(sectionStart, sectionEnd);
    const updates = [...section.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/gi)];
    return updates.map((update, updateIndex) => {
      const title = htmlText(update[2] ?? "");
      // A heading with no id and a title with no latin letters still needs a stable anchor.
      const anchor = attribute(update[1] ?? "", "id") || slug(title) || `update-${updateIndex + 1}`;
      const bodyStart = (update.index ?? 0) + update[0].length;
      const bodyEnd = updates[updateIndex + 1]?.index ?? section.length;
      return { date, anchor, title, summary: htmlText(section.slice(bodyStart, bodyEnd)).slice(0, 1_200) };
    });
  });
  // A heading with no id of its own falls back to its title, and two updates of one day can share one.
  const records = distinctIds(
    entriesSchema.parse(parsed).map((entry) => ({
      id: `${entry.date}:${entry.anchor}`,
      name: entry.title,
      url: `${DEEPSEEK_UPDATES_URL}#${entry.anchor}`,
      maker: "DeepSeek",
      published: `${entry.date}T00:00:00.000Z`,
      summary: entry.summary || null,
    })),
  );
  return {
    source: "deepseek-updates",
    stream: "news",
    url: DEEPSEEK_UPDATES_URL,
    raw: html,
    trackChanges: true,
    records,
  };
}

export async function collectDeepSeekUpdates(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseDeepSeekUpdates(await fetchText(DEEPSEEK_UPDATES_URL, {}, request, undefined, cache));
}

function tableRows(html: string): string[][] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new SourceError("missing-content", "DeepSeek pricing table not found");
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].flatMap((cell) => {
      const span = Number(attribute(cell[1] ?? "", "colspan") ?? "1");
      return Array.from({ length: Number.isInteger(span) && span > 0 ? span : 1 }, () => htmlText(cell[2] ?? ""));
    }),
  );
}

function money(value: string): number | null {
  const parsed = Number(value.replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function priceKey(section: string, period: string): string {
  const suffix = period.toLowerCase() === "peak" ? "Peak" : "OffPeak";
  return `${section}${suffix}`;
}

/**
 * The ceiling a cell states, without the word the row already is.
 *
 * DeepSeek writes the cell under MAX OUTPUT as "MAXIMUM: 384K", so the card rendered it under a
 * field of its own and read "Max output: MAXIMUM: 384K" -- the same word twice and a colon in the
 * middle of a number. The qualifier is the page's typography for a row whose label is three cells
 * to the left, and it says nothing the field name has not.
 *
 * Only a leading all-caps word and its colon are taken off. A cell that says something this parser
 * does not recognise is kept whole, because a number with a condition on it is still worth printing
 * as the page wrote it: "384K (beta)" is not a cell to start guessing about.
 */
function ceiling(cell: string | undefined): string | null {
  if (!cell) return null;
  const stated = cell.replace(/^[A-Z][A-Z\s]*:\s*/, "").trim();
  return stated || null;
}

/** Parse the official table without turning a missing or malformed page into an empty catalogue. */
export function parseDeepSeekPricing(html: string): Collection {
  const rows = tableRows(html);
  const modelRow = rows.find((row) => row.some((cell) => cell.toUpperCase() === "MODEL"));
  // A footnote marker is typography, not the model's name: `deepseek-flash (1)` is deepseek-flash,
  // and keeping the marker would remove and re-announce the model when the footnotes are renumbered.
  const models = (modelRow ?? [])
    .filter((cell) => cell && cell.toUpperCase() !== "MODEL")
    .map((cell) => cell.replace(/(?:\s*[([]\d+[)\]]|\s+\d+|[\s*†‡¹²³⁴⁵⁶⁷⁸⁹⁰]+)+$/u, "").trim())
    .filter(Boolean);
  if (!models.length) throw new SourceError("missing-content", "DeepSeek pricing models not found");

  const records = models.map<RecordData>((model) => ({
    id: model,
    name: model,
    maker: "DeepSeek",
    model,
    url: DEEPSEEK_PRICING_URL,
    capabilities: [],
    pricing: {},
  }));
  let section = "";
  let period = "";
  // A label cell spanning several rows is written on the first of them only. Which group a row
  // belongs to is carried forward, as the section and the period are, or every row after the first
  // in a group reads as unlabelled.
  let group: "features" | "pricing" | null = null;
  const priced = { rows: 0, stored: 0 };
  for (const row of rows) {
    if (row === modelRow) continue;
    const values = row.slice(-models.length);
    const labels = row.slice(0, -models.length);
    const label = labels.join(" ").replace(/\s+/g, " ").trim();
    const upper = label.toUpperCase();
    const currentSection = upper.match(/1M INPUT TOKENS \(CACHE HIT\)/)
      ? "inputCacheHit"
      : upper.match(/1M INPUT TOKENS \(CACHE MISS\)/)
        ? "inputCacheMiss"
        : upper.match(/1M OUTPUT TOKENS/)
          ? "output"
          : null;
    if (upper.includes("FEATURES")) group = "features";
    else if (upper.includes("PRICING") || currentSection) group = "pricing";
    else if (/MODEL VERSION|CONTEXT LENGTH|MAX OUTPUT|CONCURRENCY LIMIT/.test(upper)) group = null;
    // A new price section starts without a period until it names one; inheriting the previous
    // section's would file a price under the wrong key.
    if (currentSection && currentSection !== section) period = "";
    if (currentSection) section = currentSection;
    const currentPeriod = upper.match(/\b(OFF-PEAK|PEAK)\b/)?.[1];
    if (currentPeriod) period = currentPeriod;
    if (upper.includes("MODEL VERSION")) {
      records.forEach((record, index) => {
        record.modelVersion = values[index] ?? null;
      });
    } else if (upper.includes("CONTEXT LENGTH")) {
      records.forEach((record, index) => {
        record.context = values[index] ?? null;
      });
    } else if (upper.includes("MAX OUTPUT")) {
      records.forEach((record, index) => {
        record.maxOutput = ceiling(values[index]);
      });
    } else if (upper.includes("CONCURRENCY LIMIT")) {
      records.forEach((record, index) => {
        const value = Number(values[index]);
        record.concurrencyLimit = Number.isInteger(value) && value >= 0 ? value : null;
      });
    } else if (group === "features") {
      records.forEach((record, index) => {
        if (values[index] === "✓") {
          const feature = labels.at(-1);
          if (feature && Array.isArray(record.capabilities)) record.capabilities.push(feature);
        }
      });
    } else if (section) {
      // A table without peak and off-peak rows has one price per section, under the section's name.
      priced.rows++;
      records.forEach((record, index) => {
        const value = money(values[index] ?? "");
        if (value !== null && record.pricing && typeof record.pricing === "object") {
          (record.pricing as Record<string, number>)[period ? priceKey(section, period) : section] = value;
          priced.stored++;
        }
      });
    }
  }
  // Price rows that yielded no price are a table this parser no longer understands, not free models.
  if (priced.rows && !priced.stored) throw new SourceError("schema", "DeepSeek pricing rows carried no readable price");
  const parsed = pricingRecordsSchema.parse(records);
  return {
    source: "deepseek-pricing",
    stream: "api-models",
    url: DEEPSEEK_PRICING_URL,
    raw: html,
    confirmChanges: true,
    records: parsed,
  };
}

export async function collectDeepSeekPricing(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseDeepSeekPricing(await fetchText(DEEPSEEK_PRICING_URL, {}, request, undefined, cache));
}

export function parseDeepSeekModels(payload: string): Collection {
  const data = modelsSchema.parse(JSON.parse(payload));
  return {
    source: "deepseek-api",
    stream: "api-models",
    url: DEEPSEEK_MODELS_URL,
    raw: payload,
    confirmChanges: true,
    records: data.data.map((model) => ({
      id: model.id,
      // The list is the only place the slug and the product name are said together, so the name it
      // gives wins; the slug stands in when the list does not name the model at all.
      name: model.name ?? model.id,
      maker: "DeepSeek",
      model: model.id,
      owner: model.owned_by,
      url: DEEPSEEK_MODELS_URL,
      context: model.context_window ?? null,
      maxOutput: model.max_output_tokens ?? null,
      inputModalities: model.input_modalities ?? null,
      outputModalities: model.output_modalities ?? null,
      effortLevels: model.effort?.supported_levels ?? null,
      defaultEffort: model.effort?.default_level ?? null,
      apiCapabilities: model.api_capabilities ? Object.keys(model.api_capabilities).sort() : null,
    })),
  };
}

export async function collectDeepSeekModels(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  return parseDeepSeekModels(
    await fetchText(DEEPSEEK_MODELS_URL, { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}` }, request),
  );
}
