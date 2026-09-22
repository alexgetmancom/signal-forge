import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { googleCloudHeaders } from "./vertex.js";

/** Vertex AI and the Gemini API, the two billing services a Google model is priced under. */
const SERVICES = { "C7E2-9256-1C43": "Vertex AI", "AEFD-7695-64FA": "Gemini API" } as const;

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

/**
 * The Google Cloud price catalogue for Google's model services. The two services are 11.7 MB and 0.1 MB
 * a read and carry no validator, so they are read hourly; an unchanged list stores nothing.
 */
export async function collectGoogleSkus(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const headers = await googleCloudHeaders(config, request, false);
  const records = new Map<string, { id: string; name: string; maker: string; services: string[] }>();
  for (const [service, label] of Object.entries(SERVICES)) {
    const descriptions: string[] = [];
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error(`Google Cloud SKU pagination exceeded limit for ${label}`);
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?pageSize=5000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
      const response = await request(url, { headers });
      if (!response.ok) throw new Error(`Google Cloud SKUs for ${label}: HTTP ${response.status}`);
      const data = skusSchema.parse(await response.json());
      descriptions.push(...(data.skus ?? []).map((sku) => sku.description));
      if (!data.nextPageToken || data.nextPageToken === cursor) break;
      cursor = data.nextPageToken;
    }
    if (!descriptions.length) throw new Error(`Google Cloud lists no SKUs for ${label}`);
    for (const model of skuModels(descriptions)) {
      const record = records.get(model) ?? { id: model, name: model, maker: "Google Cloud", services: [] };
      record.services.push(label);
      records.set(model, record);
    }
  }
  return {
    source: "google-skus",
    stream: "api-models",
    url: "https://cloud.google.com/skus",
    raw: [...records.keys()].join("\n"),
    records: [...records.values()],
  };
}
