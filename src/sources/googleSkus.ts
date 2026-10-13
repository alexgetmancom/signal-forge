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
 * Only descriptions are used. Measured 2026-10-08: Google's field mask and compact JSON cut Vertex
 * from 12.31 MB to 835 KB and Gemini from 940 KB to 65 KB, with all 89 records unchanged.
 *
 * Prices were asked for on 2026-10-13 and taken back out the same hour, and what went wrong is worth
 * more than the attempt was. Gemini 4 Argon Contributor is published at $2.00 in, $0.10 cached and
 * $10.00 out per million; the card that reached the scouts said "$0.1 in · $10 out", because this
 * list prices one model in many rows and the reader took the lowest of each rate. Two rows are why:
 * Google writes a cache rate as "Input Caching", which a test for the word "cached" does not catch,
 * so the cache price was read as an input price and then won for being smaller. Regions and context
 * tiers are more of the same.
 *
 * So the lesson is not the spelling of one word. The cheapest row of a rate is not what a model
 * costs, and this list cannot say which row is the headline one without the fields that name the
 * tier a row belongs to. The next attempt reads `pricingInfo` beside `ServiceRegionalPricing` or it
 * stays out: a price is the number readers quote back, and `card_amendments(kind='priced')` exists
 * to put one onto a card that was already sent, which is what should have carried it.
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
const lastRead = new Map<string, { at: number; models: readonly string[] }>();

const skusSchema = z.object({
  skus: z.array(z.object({ description: z.string() })).optional(),
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

type SkuRecord = { id: string; name: string; maker: string; service: string; services: string[] };

/** One record per model, naming every service it is billed under. */
function remember(records: Map<string, SkuRecord>, model: string, label: string): void {
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
      for (const model of held.models) remember(records, model, label);
      continue;
    }
    const descriptions: string[] = [];
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page >= 20) throw new SourceError("protocol", `Google Cloud SKU pagination exceeded limit for ${label}`);
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?pageSize=5000&prettyPrint=false&fields=skus(description),nextPageToken${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetchResponse(url, { headers }, request);
      if (!response.ok) throw httpFailure(`Google Cloud SKUs for ${label}: HTTP ${response.status}`, response.status);
      const data = skusSchema.parse(JSON.parse((await readResponseBytes(response)).toString("utf8")));
      descriptions.push(...(data.skus ?? []).map((sku) => sku.description));
      if (!data.nextPageToken || data.nextPageToken === cursor) break;
      cursor = data.nextPageToken;
    }
    if (!descriptions.length) throw new SourceError("empty", `Google Cloud lists no SKUs for ${label}`);
    const models = skuModels(descriptions);
    lastRead.set(service, { at: now, models });
    for (const model of models) remember(records, model, label);
  }
  return {
    source: "google-skus",
    stream: "api-models",
    url: "https://cloud.google.com/skus",
    raw: [...records.keys()].join("\n"),
    records: [...records.values()],
  };
}
