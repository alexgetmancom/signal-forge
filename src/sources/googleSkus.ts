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
 * The two are nothing alike to read. Vertex AI is 11.7 MB a pass and prices every model Google
 * resells, Anthropic's and Meta's included; the Gemini API is 0.1 MB and prices Google's own, which
 * is the list a Gemini release appears on before it is announced -- Gemini 3.8 Flash TTS and Flash
 * Lite TTS did, on 2026-09-21. One interval for both meant the cheap list that matters most was read
 * as rarely as the expensive one that matters least: hourly, for 312 MB a day.
 *
 * So the cadence is per service rather than per source. The small list is read every time the source
 * runs and the large one keeps its hour, which buys twelve times the resolution on a Gemini price for
 * about 1.2 MB a day more.
 *
 * Not two sources, which is the other way to say this: a record carries the services it was found
 * under, and splitting the id would have moved 38 Vertex-only models to a new source and announced
 * every one of them as new, to say nothing of changing `services` on the 35 priced under both.
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

/**
 * Model names in a price list, one per model however many ways it is billed. "Generate content input
 * token count gemini 3.8 flash lite tts text batch" is `gemini-3.8-flash-lite-tts`. A price is on the
 * list before the model is announced: Gemini 3.8 Flash TTS and Flash Lite TTS were, on 2026-09-21.
 */
export function skuModels(descriptions: readonly string[]): string[] {
  const models = new Set<string>();
  for (const description of descriptions)
    for (const [, family = "", version = "", variant = ""] of description.matchAll(MODEL))
      models.add([family, version, ...variant.trim().split(/[ -]+/)].filter(Boolean).join("-").toLowerCase());
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
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?pageSize=5000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
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
