import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { fetchResponse, readResponseBytes } from "./http.js";
import { googleCloudHeaders } from "./vertex.js";

/**
 * Vertex AI and the Gemini API, the two billing services a Google model is priced under, and how
 * often each is worth asking.
 *
 * The two are nothing alike to read. Vertex AI prices every model Google resells, Anthropic's and
 * Meta's included; the Gemini API prices Google's own, which is the list a Gemini release appears on
 * before it is announced -- Gemini 3.8 Flash TTS and Flash Lite TTS did, on 2026-09-21, and Gemini 4
 * Argon Contributor was priced here before any catalogue carried it. One interval for both meant the
 * cheap list that matters most was read as rarely as the expensive one that matters least.
 *
 * So the cadence is per service rather than per source: the small list is read every time the source
 * runs and the large one keeps its hour.
 *
 * Not two sources, which is the other way to say this: a record carries the services it was found
 * under, and splitting the id would have moved 38 Vertex-only models to a new source and announced
 * every one of them as new, to say nothing of changing `services` on the 35 priced under both.
 *
 * The field mask is what keeps the read small -- measured 2026-10-08, descriptions alone and compact
 * JSON cut Vertex from 12.31 MB to 835 KB and Gemini from 940 KB to 65 KB. It now also asks for the
 * usage unit and the first tier's price by name, which is three scalars a row and no bodies; what
 * that costs is `prod traffic` after the next deploy rather than a number guessed here.
 */
const SERVICES = {
  "C7E2-9256-1C43": { label: "Vertex AI", everyMs: 3_600_000 },
  "AEFD-7695-64FA": { label: "Gemini API", everyMs: 0 },
} as const;

/**
 * The last reading of each service, held for as long as that service's interval allows.
 *
 * This is in memory and not in the database on purpose: it is not an observation, it is the pass we
 * would otherwise repeat. A restart simply reads both lists once, which is what every restart did.
 */
const lastRead = new Map<string, { at: number; readings: readonly SkuReading[] }>();

/**
 * A SKU as the field mask asks for it: what it is called, what it is charged per, and the first
 * tier's price. `startUsageAmount` is not asked for, so the tiers are read in the order the API
 * returns them and only the first is read -- which is the price a reader pays from the first token,
 * and the one a card quotes.
 */
const skuSchema = z.object({
  description: z.string(),
  pricingInfo: z
    .array(
      z.object({
        pricingExpression: z
          .object({
            usageUnit: z.string().optional(),
            tieredRates: z
              .array(
                z.object({
                  unitPrice: z.object({ units: z.string().optional(), nanos: z.number().optional() }).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

type Sku = z.infer<typeof skuSchema>;

const skusSchema = z.object({
  skus: z.array(skuSchema).optional(),
  nextPageToken: z.string().optional(),
});

const MODEL =
  /\b(gemini|gemma|veo|imagen|lyria|glm|minimax|gpt-oss|llama|claude|grok|deepseek|qwen|kimi)[ -]?(\d+(?:\.\d+)?b?)((?:[ -](?:flash|pro|lite|ultra|fast|live|tts|image|cyber|nano|mini|embedding|transcribe|translate|clip|maverick|scout|preview))*)/gi;

/**
 * Words that stand where a codename would and name how a model is billed rather than which model it
 * is. A tier, a region and a modality all sit in this position; `MODEL`'s own list already holds the
 * words that are part of a name, so a word here is one or the other and never both.
 */
const GOOGLE_FAMILY = new Set(["gemini", "gemma", "veo", "imagen", "lyria"]);

/**
 * The words this price list uses for which deal a row prices rather than which model: a tier, and a
 * region, which is sold as one. Kept apart from the rest of `BILLING_WORD` because a tier is worth
 * recording -- "Gemini 4 Argon Contributor" is a published tier, and what a reader pays depends on
 * which one they are on -- where "input" and "count" are only the shape of a price list.
 */
const BILLING_TIER = new Set([
  "standard",
  "global",
  "regional",
  "offpeak",
  "batch",
  "interactive",
  "provisioned",
  "dynamic",
  "shared",
  "enterprise",
  "contributor",
]);

const BILLING_WORD = new Set([
  ...BILLING_TIER,
  "input",
  "output",
  "cached",
  "caching",
  "text",
  "audio",
  "video",
  "token",
  "tokens",
  "count",
  "context",
  "long",
  "short",
  "prompt",
  "thinking",
  "grounding",
  "search",
  "tuning",
  "training",
  "storage",
  "request",
  "requests",
  "character",
  "characters",
  "node",
  "hour",
  "day",
  "api",
  "model",
  "service",
]);

/**
 * A codename the price list writes where no known variant follows the version: "Gemini 4 Argon
 * Contributor" is `gemini-4-argon`, and `MODEL` on its own reads it as `gemini-4` -- which is what
 * the public channel said on 2026-10-07, and a plausible number does not look like a mistake.
 *
 * Read only in that one position, and only of a word `BILLING_WORD` does not claim. Both guards are
 * needed and neither is enough: "Gemini 3.8 Flash Cyber Global Text Input Caching Offpeak" puts a
 * region where this would otherwise read a name, and a tier sits directly after a version whenever
 * the model has no variant at all. A codename that also carries a variant -- `gemini-4-argon-high`
 * -- is not on this list; those are written in the clients, which is `antigravity-binaries`.
 */
function skuCodename(description: string, at: number, family: string, variant: string): string | null {
  if (variant.trim() || !GOOGLE_FAMILY.has(family.toLowerCase())) return null;
  const next = /^[ -]([a-z]{3,})\b/i.exec(description.slice(at))?.[1]?.toLowerCase();
  return next && !BILLING_WORD.has(next) ? next : null;
}

/**
 * Model names in a price list, one per model however many ways it is billed. "Generate content input
 * token count gemini 3.8 flash lite tts text batch" is `gemini-3.8-flash-lite-tts`. A price is on the
 * list before the model is announced: Gemini 3.8 Flash TTS and Flash Lite TTS were, on 2026-09-21.
 *
 * A codenamed model is named twice, under the stem and under the codename, rather than once under the
 * codename. The stem is a row this source has already published -- `gemini-4` has been one since
 * 2026-10-07 -- and moving it would retire that row, which reads as a model withdrawn. An id nobody
 * announces costs a silent row; a withdrawal nobody made costs a card.
 */
export function skuModels(descriptions: readonly string[]): string[] {
  const models = new Set<string>();
  for (const description of descriptions)
    for (const match of description.matchAll(MODEL)) {
      const [whole, family = "", version = "", variant = ""] = match;
      const stem = [family, version, ...variant.trim().split(/[ -]+/)].filter(Boolean).join("-").toLowerCase();
      models.add(stem);
      const codename = skuCodename(description, (match.index ?? 0) + whole.length, family, variant);
      if (codename) models.add(`${stem}-${codename}`);
    }
  return [...models].sort();
}

/**
 * Which of a model's three token prices a SKU is for, or nothing if the row is not a token price at
 * all. A price list bills images per image and a tuning node per hour, and neither is what a reader
 * means by what a model costs; `the_modality_a_price_list_bills_for` is the other half of this.
 */
function rateOf(description: string): "input" | "cachedInput" | "output" | null {
  const text = description.toLowerCase();
  if (!/\btokens?\b/.test(text)) return null;
  if (text.includes("cached")) return "cachedInput";
  if (text.includes("output")) return "output";
  return text.includes("input") ? "input" : null;
}

/**
 * A tier that is a discount rather than a price: the same model, charged less for being allowed to
 * wait. Read as a tier and never as the price, because the lowest number on the list would
 * otherwise become the one on the card -- Gemini's batch rows are half of the standard ones.
 */
const DISCOUNT_TIER = ["batch", "offpeak", "provisioned"];

/** The tiers a description names, which is what the row is a price for rather than which model. */
function tiersOf(description: string): string[] {
  const words = description.toLowerCase().split(/[^a-z]+/);
  return [...new Set(words.filter((word) => BILLING_TIER.has(word)))].sort();
}

/** Dollars per usage unit, which for these rows is one token. */
function priceOf(sku: Sku): number | null {
  const expression = sku.pricingInfo?.[0]?.pricingExpression;
  if (expression?.usageUnit !== "count") return null;
  const price = expression.tieredRates?.[0]?.unitPrice;
  if (!price) return null;
  const dollars = Number(price.units ?? "0") + (price.nanos ?? 0) / 1_000_000_000;
  // A zero is the blank this list writes for a row that is priced elsewhere, and a reader of
  // `pricing` cannot tell one from a model that is free; `isAResellerFillingInAPrice` reads both the
  // same way, so writing it would be writing nothing with a number's authority.
  return Number.isFinite(dollars) && dollars > 0 ? dollars : null;
}

/** One model as this price list writes it: its name, the tiers it is billed under and its prices. */
type SkuReading = { model: string; pricingTiers: string[]; pricing: Record<string, number> };

/**
 * The price list read as models rather than as rows. One model is billed many ways -- per modality,
 * per region, per tier -- so the lowest standard price of each rate is the model's price, and a
 * discount tier is recorded as a tier and priced not at all.
 *
 * Prices are dollars per token, which is the unit `priceUnitForSource` gives any source it does not
 * name. A sheet read in the wrong unit is wrong by a million on a card people quote.
 */
function skuReadings(skus: readonly Sku[]): SkuReading[] {
  const readings = new Map<string, SkuReading>();
  for (const sku of skus) {
    const rate = rateOf(sku.description);
    const price = DISCOUNT_TIER.some((tier) => sku.description.toLowerCase().includes(tier)) ? null : priceOf(sku);
    for (const model of skuModels([sku.description])) {
      const reading = readings.get(model) ?? { model, pricingTiers: [], pricing: {} };
      reading.pricingTiers = [...new Set([...reading.pricingTiers, ...tiersOf(sku.description)])].sort();
      const held = reading.pricing[rate ?? ""];
      if (rate && price !== null && (held === undefined || price < held)) reading.pricing[rate] = price;
      readings.set(model, reading);
    }
  }
  return [...readings.values()].sort((one, other) => one.model.localeCompare(other.model));
}

type SkuRecord = {
  id: string;
  name: string;
  maker: string;
  service: string;
  services: string[];
  pricingTiers?: string[];
  pricing?: Record<string, number>;
};

/** One record per model, naming every service it is billed under. */
function remember(records: Map<string, SkuRecord>, reading: SkuReading, label: string): void {
  const model = reading.model;
  // The service is not the maker. GLM 5, Qwen 3.6, Llama 4 and GPT-OSS are all priced here and were
  // all filed under "Google Cloud", so a card for any of them named the wrong company.
  const maker = vendorOfName(model);
  const record = records.get(model) ?? {
    id: model,
    name: model,
    maker: maker === "Unknown" ? "Google" : maker,
    service: "Google Cloud",
    services: [],
  };
  if (!record.services.includes(label)) record.services.push(label);
  // `pricingTiers` rather than `tiers`, which is not cosmetic: `isAResellerFillingInAPrice` only
  // forgives a field whose name reads as part of a price, and this one appears on all ninety rows
  // at once the first time the field mask asks for it. Named `tiers` it was ninety cards.
  const tiers = [...new Set([...(record.pricingTiers ?? []), ...reading.pricingTiers])].sort();
  if (tiers.length) record.pricingTiers = tiers;
  for (const [rate, price] of Object.entries(reading.pricing)) {
    const held = record.pricing?.[rate];
    if (held === undefined || price < held) record.pricing = { ...record.pricing, [rate]: price };
  }
  records.set(model, record);
}

/**
 * The Google Cloud price catalogue for Google's model services. Neither service carries a validator,
 * so a read is the whole list however little of it moved; an unchanged list stores nothing. What each
 * read costs, and therefore how often it is made, is in `SERVICES`.
 */
export async function collectGoogleSkus(
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<Collection> {
  const headers = await googleCloudHeaders(config, request, false);
  const records = new Map<string, SkuRecord>();
  for (const [service, { label, everyMs }] of Object.entries(SERVICES)) {
    const held = lastRead.get(service);
    if (held && now - held.at < everyMs) {
      // Still within this service's interval: the models it last listed stand, so the collection is
      // whole and the source's own interval is free to be shorter than this one.
      for (const reading of held.readings) remember(records, reading, label);
      continue;
    }
    const skus: Sku[] = [];
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page >= 20) throw new SourceError("protocol", `Google Cloud SKU pagination exceeded limit for ${label}`);
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?pageSize=5000&prettyPrint=false&fields=skus(description,pricingInfo/pricingExpression/usageUnit,pricingInfo/pricingExpression/tieredRates/unitPrice),nextPageToken${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetchResponse(url, { headers }, request);
      if (!response.ok) throw httpFailure(`Google Cloud SKUs for ${label}: HTTP ${response.status}`, response.status);
      const data = skusSchema.parse(JSON.parse((await readResponseBytes(response)).toString("utf8")));
      skus.push(...(data.skus ?? []));
      if (!data.nextPageToken || data.nextPageToken === cursor) break;
      cursor = data.nextPageToken;
    }
    if (!skus.length) throw new SourceError("empty", `Google Cloud lists no SKUs for ${label}`);
    const readings = skuReadings(skus);
    lastRead.set(service, { at: now, readings });
    for (const reading of readings) remember(records, reading, label);
  }
  return {
    source: "google-skus",
    stream: "api-models",
    url: "https://cloud.google.com/skus",
    raw: [...records.keys()].join("\n"),
    records: [...records.values()],
  };
}
