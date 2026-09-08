import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Fetch } from "../delivery.js";
import type { Collection, RecordData } from "../events.js";
import { fetchText } from "./http.js";

const openRouterSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        created: z.number(),
        context_length: z.number().nullable(),
        pricing: z.record(z.string(), z.unknown()),
        architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
        supported_parameters: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});
export async function collectOpenRouter(request: Fetch = fetch): Promise<Collection> {
  const url = "https://openrouter.ai/api/v1/models",
    raw: unknown = JSON.parse(await fetchText(url, {}, request));
  const data = openRouterSchema.parse(raw);
  return {
    source: "openrouter",
    stream: "openrouter",
    confirmChanges: true,
    url,
    raw,
    records: data.data.map((m) => ({
      id: m.id,
      name: m.name,
      created: new Date(m.created * 1000).toISOString(),
      context: m.context_length,
      pricing: m.pricing,
      input: [...m.architecture.input_modalities].sort(),
      output: [...m.architecture.output_modalities].sort(),
      parameters: [...(m.supported_parameters ?? [])].sort(),
    })),
  };
}
const openAiSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), created: z.number(), owned_by: z.string() })).min(1),
});
export async function collectOpenAI(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const url = "https://api.openai.com/v1/models",
    raw: unknown = JSON.parse(await fetchText(url, { Authorization: `Bearer ${config.OPENAI_API_KEY}` }, request));
  return {
    source: "openai",
    stream: "api-models",
    url,
    raw,
    records: openAiSchema.parse(raw).data.map((m) => ({
      id: m.id,
      name: m.id,
      owner: m.owned_by,
      created: new Date(m.created * 1000).toISOString(),
    })),
  };
}
const anthropicSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), display_name: z.string(), created_at: z.string() })),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});
export async function collectAnthropic(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const url = "https://api.anthropic.com/v1/models",
    raw: unknown[] = [],
    records: RecordData[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(
        `${url}?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
        { "x-api-key": config.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
        request,
      ),
    );
    const data = anthropicSchema.parse(body);
    raw.push(body);
    records.push(...data.data.map((m) => ({ id: m.id, name: m.display_name, created: m.created_at })));
    if (!data.has_more) return { source: "anthropic", stream: "api-models", url, raw, records };
    if (!data.last_id || data.last_id === cursor) throw new Error("Anthropic pagination did not advance");
    cursor = data.last_id;
  }
  throw new Error("Anthropic pagination exceeded limit");
}
const geminiSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      displayName: z.string(),
      inputTokenLimit: z.number(),
      outputTokenLimit: z.number(),
      supportedGenerationMethods: z.array(z.string()),
    }),
  ),
  nextPageToken: z.string().optional(),
});
export async function collectGemini(config: AppConfig, request: Fetch = fetch): Promise<Collection> {
  const url = "https://generativelanguage.googleapis.com/v1beta/models",
    raw: unknown[] = [],
    records: RecordData[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(
        `${url}?pageSize=1000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`,
        { "x-goog-api-key": config.GEMINI_API_KEY ?? "" },
        request,
      ),
    );
    const data = geminiSchema.parse(body);
    raw.push(body);
    records.push(
      ...data.models.map((m) => ({
        id: m.name,
        name: m.displayName,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        methods: [...m.supportedGenerationMethods].sort(),
      })),
    );
    if (!data.nextPageToken) return { source: "gemini", stream: "api-models", url, raw, records };
    if (data.nextPageToken === cursor) throw new Error("Gemini pagination did not advance");
    cursor = data.nextPageToken;
  }
  throw new Error("Gemini pagination exceeded limit");
}
