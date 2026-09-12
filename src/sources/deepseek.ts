import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { slug } from "../text.js";
import { attribute, htmlText } from "./html.js";
import { fetchText } from "./http.js";

const DEEPSEEK_UPDATES_URL = "https://api-docs.deepseek.com/updates";
const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/?article_id=article_1779470751466_8";
const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

const modelsSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string().min(1), owned_by: z.string().min(1) })).min(1),
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
  if (!article) throw new Error("DeepSeek changelog article not found");

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
      const anchor = attribute(update[1] ?? "", "id") ?? slug(title);
      const bodyStart = (update.index ?? 0) + update[0].length;
      const bodyEnd = updates[updateIndex + 1]?.index ?? section.length;
      return { date, anchor, title, summary: htmlText(section.slice(bodyStart, bodyEnd)).slice(0, 1_200) };
    });
  });
  const records = entriesSchema.parse(parsed).map((entry) => ({
    id: `${entry.date}:${entry.anchor}`,
    name: entry.title,
    url: `${DEEPSEEK_UPDATES_URL}#${entry.anchor}`,
    maker: "DeepSeek",
    published: `${entry.date}T00:00:00.000Z`,
    summary: entry.summary || null,
  }));
  return {
    source: "deepseek-updates",
    stream: "news",
    url: DEEPSEEK_UPDATES_URL,
    raw: html,
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

export async function collectDeepSeekUpdates(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseDeepSeekUpdates(await fetchText(DEEPSEEK_UPDATES_URL, {}, request, undefined, cache));
}

function tableRows(html: string): string[][] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new Error("DeepSeek pricing table not found");
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

/** Parse the official table without turning a missing or malformed page into an empty catalogue. */
export function parseDeepSeekPricing(html: string): Collection {
  const rows = tableRows(html);
  const modelRow = rows.find((row) => row.some((cell) => cell.toUpperCase() === "MODEL"));
  const models = (modelRow ?? []).filter((cell) => cell && cell.toUpperCase() !== "MODEL");
  if (!models.length) throw new Error("DeepSeek pricing models not found");

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
        record.maxOutput = values[index] ?? null;
      });
    } else if (upper.includes("CONCURRENCY LIMIT")) {
      records.forEach((record, index) => {
        const value = Number(values[index]);
        record.concurrencyLimit = Number.isInteger(value) && value >= 0 ? value : null;
      });
    } else if (upper.includes("FEATURES")) {
      records.forEach((record, index) => {
        if (values[index] === "✓") {
          const feature = labels.at(-1);
          if (feature && Array.isArray(record.capabilities)) record.capabilities.push(feature);
        }
      });
    } else if (section && period) {
      records.forEach((record, index) => {
        const value = money(values[index] ?? "");
        if (value !== null && record.pricing && typeof record.pricing === "object")
          (record.pricing as Record<string, number>)[priceKey(section, period)] = value;
      });
    }
  }
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
      name: model.id,
      maker: "DeepSeek",
      model: model.id,
      owner: model.owned_by,
      url: DEEPSEEK_MODELS_URL,
    })),
  };
}

export async function collectDeepSeekModels(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  return parseDeepSeekModels(
    await fetchText(DEEPSEEK_MODELS_URL, { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}` }, request),
  );
}
