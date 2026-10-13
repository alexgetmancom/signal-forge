import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { fetchResponse, readResponseBytes } from "./http.js";
import { googleCloudHeaders } from "./vertex.js";

/**
 * Read Gemini's own list every pass and Vertex's reseller catalogue hourly. Keep both services in
 * one collection so a model priced under both retains one record with both service labels.
 * Measured 2026-10-08: Google's field mask and compact JSON cut Vertex from 12.31 MB to 835 KB and
 * Gemini from 940 KB to 65 KB, with all 89 records unchanged.
 *
 * Rates are asked of Gemini's list only, which is `prices` in `SERVICES`. Measured 2026-10-13, the
 * mask that carries them costs 2.55x: Gemini 67 KB to 172 KB a read and Vertex 824 KB to 2.10 MB.
 * Gemini's is the list read every five minutes and the one where Google prices Google's models
 * first, so it is worth +30 MB a day; Vertex's hourly 2.10 MB would buy the same numbers again for
 * Google's models and a reseller's numbers for everyone else's, which `PRICED_BY` does not quote.
 *
 * Prices were asked for on 2026-10-13, published wrongly, taken back out the same hour and read
 * again properly that afternoon. The failure is worth more than the attempt was. Gemini 4 Argon
 * Contributor is published at $2.00 in, $0.10 cached and $10.00 out per million; the card that
 * reached the scouts said "$0.1 in $10 out", because this list prices one model in many rows and the
 * reader took the lowest of each rate. Google writes a cache rate as "Input Caching", which a test
 * for the word "cached" does not catch, so the cache price was read as an input price and then won
 * for being smaller.
 *
 * The lesson was not the spelling of one word: the cheapest row of a rate is not what a model costs.
 * So `headlineRate` names the one row a reader pays -- plain generation, no tier, no cache, text, the
 * base context tier -- and `skuPrices` stores nothing at all where two surviving rows disagree,
 * which is the case the first reader resolved by taking the smaller number. Checked against five
 * prices Google publishes in words: 2.0 Flash $0.10/$0.40, 2.0 Flash Lite $0.075/$0.30, 1.5 Pro
 * $1.25/$5.00, 2.5 Flash $0.30/$2.50, 2.5 Pro $1.25/$10.00. Argon reads $4.00/$20.00 on demand, and
 * the $2.00 in the report is its `contributor` tier -- the discount tiers are not stored, because a
 * number nobody is quoted is not a price.
 *
 * Dollars per million is the unit, as `price_1m_input_tokens` is at Artificial Analysis, and
 * `priceUnitForSource` is told so. The rates are `input`, `output` and `input_cache_read`, which are
 * the names a card renders; the first attempt stored `cachedInput` and a card printed it raw.
 */
const SERVICES = {
  "C7E2-9256-1C43": { label: "Vertex AI", everyMs: 3_600_000, prices: false },
  "AEFD-7695-64FA": { label: "Gemini API", everyMs: 0, prices: true },
} as const;

/**
 * The last reading of each service, held for as long as that service's interval allows.
 *
 * This is in memory and not in the database on purpose: it is not an observation, it is the pass we
 * would otherwise repeat. A restart simply reads both lists once, which is what every restart did.
 */
const lastRead = new Map<
  string,
  { at: number; models: readonly string[]; prices: ReadonlyMap<string, Record<string, number>> }
>();

const skusSchema = z.object({
  skus: z
    .array(
      z.object({
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
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const MODEL =
  /\b(gemini|gemma|veo|imagen|lyria|glm|minimax|gpt-oss|llama|claude|grok|deepseek|qwen|kimi)[ -]?(\d+(?:\.\d+)?b?)((?:[ -](?:flash|pro|lite|ultra|fast|live|tts|image|cyber|nano|mini|embedding|transcribe|translate|clip|maverick|scout|preview))*)/gi;

const GOOGLE_FAMILY = new Set(["gemini", "gemma", "veo", "imagen", "lyria"]);

/**
 * Words that stand where a codename would and say how a model is billed rather than which model it
 * is: a tier, a region, a plan, a modality, and the thing being charged for. `MODEL`'s own list
 * already holds the words that are part of a name, so a word here is one or the other, never both.
 *
 * Five of these were learned from production rather than from reading: the first poll after this
 * list shipped published `gemini-2.5-free`, `gemini-3-paid`, `imagen-4-generation`,
 * `imagen-4-upscale` and `lyria-3-music` as models, thirteen rows in one batch, of which one was a
 * model. A closed list of words to refuse is a list nobody can finish, which is why nothing here
 * rests on it alone: see the two guards in `skuCodename`.
 */
const BILLING_WORD = new Set([
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
  "free",
  "paid",
  "generation",
  "upscale",
  "music",
  "editing",
  "input",
  "output",
  "cached",
  "caching",
  "cache",
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
 * -- is not on this list; those are written in the clients, which `antigravity-cli-models` reads.
 *
 * Google's own families only. The same reading of "Claude 4.8 Sonnet" is right and nobody asked for
 * it: Vertex resells thirty-eight models whose names are already on every catalogue this service
 * reads, and widening a price list's spelling of them announces a row each. A codename is worth
 * reading where the price list is the first place it is written, which is the maker's own list.
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
 * One row of the price list, as the fields this reads leave it: a sentence, what it is charged per,
 * and dollars per million of that unit.
 */
/** One row of the list as the field mask leaves it. */
type Sku = NonNullable<z.infer<typeof skusSchema>["skus"]>[number];

export type PricedSku = { description: string; usageUnit: string | null; perMillion: number | null };

/**
 * Dollars per million units of a rate.
 *
 * `units` is a whole-dollar string and `nanos` a billionth, so a million of them is `units` millions
 * plus `nanos` thousandths -- done in those terms rather than by multiplying a float, because
 * `(0 + 200 / 1e9) * 1e6` is 0.19999999999999998 and that is what a card would have quoted.
 */
function perMillion(sku: Sku): number | null {
  const rates = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates ?? [];
  // A rate with more than one tier is a quantity discount, and the first tier is not "the" price.
  // Measured 2026-10-13 across all 782 Gemini API rows: none has two. If one appears, it is not
  // read rather than read wrongly.
  if (rates.length !== 1) return null;
  const price = rates[0]?.unitPrice;
  if (!price) return null;
  const units = Number(price.units ?? 0);
  const nanos = Number(price.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  return units * 1_000_000 + nanos / 1000;
}

/**
 * The verb a row begins with. The same call is written four ways on one list -- "Generate content",
 * "Generate_content", "GenerateContent" and "Generate content" with the modality in the middle --
 * and all four are the on-demand price. `BatchGenerateContent` and `Bidi generate content` are a
 * different product at a different price, batch at half and the live API on its own sheet, so they
 * are left to say nothing rather than to be averaged in. Anchoring at the start is what separates
 * them: a prefixed verb is a different product, and nothing else begins a row.
 */
const PLAIN_CALL = /^generate[ _]?content\b/i;

/**
 * Words that make a row a variant of the headline rate rather than the rate itself. Every one was
 * read off the live list: Gemini 4 Argon is published in forty-three rows, of which three are the
 * price a reader pays on demand and the rest are a tier (`contributor`, `flex` and `batch` at half,
 * `priority` at 1.8x), a cache (`caching`), a modality or the long-context sheet.
 */
const NOT_THE_HEADLINE_RATE =
  /\b(batch|flex|priority|contributor|offpeak|off-peak|provisioned|dynamic|interactive|non[ -]?thinking|tuning|training|grounding|search|long|paid|free)\b|\b(?:longer than|over|above)\s+\d+k\b/i;

/** A rate charged per image, second or cached hour is not a token price, whatever its words say. */
const PER_TOKEN = "count";

/**
 * Which of a model's three published rates a row is, or `null` if it is not one of them.
 *
 * This is the half that was got wrong on 2026-10-13 and it is worth being exact about: a cache rate
 * is written two ways, as "cached [text] input token count <model>" and as "<model> ... caching",
 * and only the first is on demand -- the second always carries a tier. Modality is checked because
 * input is priced per modality while output is text only, so a video input row and a text output row
 * are not two halves of one price.
 */
function headlineRate(description: string): "input" | "output" | "input_cache_read" | null {
  if (!PLAIN_CALL.test(description) || NOT_THE_HEADLINE_RATE.test(description)) return null;
  if (!/\btoken count\b/i.test(description)) return null;
  if (/\b(image|audio|video|speech|embedding)\b/i.test(description)) return null;
  // "cached input token count" and "cached text input token count" are one rate written two ways.
  if (/\bcached\b[ a-z]*?\binput token count\b/i.test(description)) return "input_cache_read";
  if (/\boutput token count\b/i.test(description)) return "output";
  if (/\binput token count\b/i.test(description)) return "input";
  return null;
}

/**
 * What each model on the list is published at, per million tokens, and nothing where the list says
 * two different things.
 *
 * A row is attributed to the most specific model it names and to one model only: "input token count
 * gemini 4 argon text" is `gemini-4-argon`'s price and emphatically not `gemini-4`'s, though
 * `skuModels` reads both ids from it -- the stem is priced by its own rows. Where two surviving rows
 * of one rate disagree, neither is stored: the reading is then not known, and the whole incident
 * this guards against was a reader that resolved exactly this case by taking the smaller number.
 *
 * Dollars per million is the unit the field carries, which `priceUnitForSource` is told about so a
 * card quotes it as written. Storing per-token here would be a sheet read in the wrong unit, wrong
 * by a million on a number people repeat.
 */
export function skuPrices(rows: readonly PricedSku[]): Map<string, Record<string, number>> {
  const seen = new Map<string, Map<string, Set<number>>>();
  for (const row of rows) {
    if (row.usageUnit !== PER_TOKEN || row.perMillion === null || !(row.perMillion > 0)) continue;
    const rate = headlineRate(row.description);
    if (!rate) continue;
    const matches = [...row.description.matchAll(MODEL)];
    if (matches.length !== 1) continue;
    const [whole = "", family = "", version = "", variant = ""] = matches[0] ?? [];
    const stem = [family, version, ...variant.trim().split(/[ -]+/)].filter(Boolean).join("-").toLowerCase();
    const codename = skuCodename(row.description, (matches[0]?.index ?? 0) + whole.length, family, variant);
    const id = codename ? `${stem}-${codename}` : stem;
    const rates = seen.get(id) ?? new Map<string, Set<number>>();
    const values = rates.get(rate) ?? new Set<number>();
    values.add(row.perMillion);
    rates.set(rate, values);
    seen.set(id, rates);
  }
  const prices = new Map<string, Record<string, number>>();
  for (const [id, rates] of seen) {
    const agreed: Record<string, number> = {};
    for (const [rate, values] of rates) {
      const [only] = [...values];
      if (values.size === 1 && only !== undefined) agreed[rate] = only;
    }
    if (Object.keys(agreed).length) prices.set(id, agreed);
  }
  return prices;
}

type SkuRecord = {
  id: string;
  name: string;
  maker: string;
  service: string;
  services: string[];
  pricing?: Record<string, number>;
};

/** One record per model, naming every service it is billed under and what it is published at. */
function remember(
  records: Map<string, SkuRecord>,
  model: string,
  label: string,
  pricing?: Record<string, number>,
): void {
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
  // Gemini's own list is read before Vertex's and both price the same models. The first service to
  // publish a rate keeps it rather than the last, so a record does not change price with the order
  // two lists happen to be read in.
  if (pricing && !record.pricing) record.pricing = pricing;
  records.set(model, record);
}

/**
 * The Google Cloud price catalogue for Google's model services. Neither service carries a validator,
 * so a read is the whole list however little of it moved; an unchanged list stores nothing. What each
 * read costs, and therefore how often it is made, is in `SERVICES`.
 */
const DESCRIPTIONS = "skus(description),nextPageToken";

const DESCRIPTIONS_AND_RATES =
  "skus(description,pricingInfo/pricingExpression/usageUnit,pricingInfo/pricingExpression/tieredRates/unitPrice),nextPageToken";

export async function collectGoogleSkus(
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<Collection> {
  const headers = await googleCloudHeaders(config, request, false);
  const records = new Map<string, SkuRecord>();
  for (const [service, { label, everyMs, prices: wanted }] of Object.entries(SERVICES)) {
    const held = lastRead.get(service);
    if (held && now - held.at < everyMs) {
      // Still within this service's interval: the models it last listed stand, so the collection is
      // whole and the source's own interval is free to be shorter than this one.
      for (const model of held.models) remember(records, model, label, held.prices.get(model));
      continue;
    }
    const rows: PricedSku[] = [];
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page >= 20) throw new SourceError("protocol", `Google Cloud SKU pagination exceeded limit for ${label}`);
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?pageSize=5000&prettyPrint=false&fields=${encodeURIComponent(wanted ? DESCRIPTIONS_AND_RATES : DESCRIPTIONS)}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetchResponse(url, { headers }, request);
      if (!response.ok) throw httpFailure(`Google Cloud SKUs for ${label}: HTTP ${response.status}`, response.status);
      const data = skusSchema.parse(JSON.parse((await readResponseBytes(response)).toString("utf8")));
      for (const sku of data.skus ?? [])
        rows.push({
          description: sku.description,
          usageUnit: sku.pricingInfo?.[0]?.pricingExpression?.usageUnit ?? null,
          perMillion: perMillion(sku),
        });
      if (!data.nextPageToken || data.nextPageToken === cursor) break;
      cursor = data.nextPageToken;
    }
    if (!rows.length) throw new SourceError("empty", `Google Cloud lists no SKUs for ${label}`);
    const models = skuModels(rows.map((row) => row.description));
    const prices = wanted ? skuPrices(rows) : new Map<string, Record<string, number>>();
    lastRead.set(service, { at: now, models, prices });
    for (const model of models) remember(records, model, label, prices.get(model));
  }
  return {
    source: "google-skus",
    stream: "api-models",
    url: "https://cloud.google.com/skus",
    raw: [...records.keys()].join("\n"),
    records: [...records.values()],
  };
}
