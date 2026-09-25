import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData, SourceAuthority } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
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
  const apiUrl = "https://openrouter.ai/api/v1/models",
    url = "https://openrouter.ai/models",
    raw: unknown = JSON.parse(await fetchText(apiUrl, {}, request));
  const data = openRouterSchema.parse(raw);
  return {
    source: "openrouter",
    stream: "openrouter",
    confirmChanges: true,
    url,
    raw,
    records: data.data.map((m) => ({
      id: m.id,
      // A listing with no display name is still a model; an empty name would fail the catalogue.
      name: m.name.trim() || m.id,
      url: `https://openrouter.ai/${m.id}`,
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
  const apiUrl = "https://api.openai.com/v1/models",
    url = "https://platform.openai.com/docs/models",
    raw: unknown = JSON.parse(await fetchText(apiUrl, { Authorization: `Bearer ${config.OPENAI_API_KEY}` }, request));
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
  const apiUrl = "https://api.anthropic.com/v1/models",
    url = "https://docs.anthropic.com/en/docs/about-claude/models",
    raw: unknown[] = [],
    records: RecordData[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(
        `${apiUrl}?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
        { "x-api-key": config.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
        request,
      ),
    );
    const data = anthropicSchema.parse(body);
    raw.push(body);
    records.push(...data.data.map((m) => ({ id: m.id, name: m.display_name, created: m.created_at })));
    if (!data.has_more) {
      if (!records.length) throw new SourceError("empty", "Anthropic catalogue has no models");
      return { source: "anthropic", stream: "api-models", url, raw, records };
    }
    if (!data.last_id || data.last_id === cursor)
      throw new SourceError("protocol", "Anthropic pagination did not advance");
    cursor = data.last_id;
  }
  throw new SourceError("protocol", "Anthropic pagination exceeded limit");
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
  const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models",
    url = "https://ai.google.dev/gemini-api/docs/models",
    raw: unknown[] = [],
    records: RecordData[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const body: unknown = JSON.parse(
      await fetchText(
        `${apiUrl}?pageSize=1000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`,
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
    if (!data.nextPageToken) {
      if (!records.length) throw new SourceError("empty", "Gemini catalogue has no models");
      return { source: "gemini", stream: "api-models", url, raw, records };
    }
    if (data.nextPageToken === cursor) throw new SourceError("protocol", "Gemini pagination did not advance");
    cursor = data.nextPageToken;
  }
  throw new SourceError("protocol", "Gemini pagination exceeded limit");
}

/**
 * Most providers answer the same `/models` request OpenAI defined, so they need one collector
 * rather than one file each. What differs is the address, the human page to link to, and which
 * key unlocks it; a provider whose key is not configured is simply not collected.
 *
 * This is the earliest a model ID can be seen from outside a lab: xAI and Z.ai both list a model
 * in their catalogue before it has a page anywhere.
 */
export type ProviderCatalogue = {
  id: string;
  name: string;
  /** The company answering for the catalogue, spelled as every other source of that company spells it. */
  vendor: string;
  apiUrl: string;
  url: string;
  key: keyof AppConfig;
  authority: SourceAuthority;
  /**
   * The provider fills OpenAI's `created` with when it answered, not when the model appeared, so
   * the field is not collected from it.
   *
   * Measured on production 2026-09-14. Mistral returns one identical value for all 46 models,
   * equal to the collection time to the second; Moonshot returns one identical value for both of
   * its models that drifts a couple of seconds an hour. Every neighbouring provider spreads
   * genuine per-model dates across years, so this is theirs specifically and not the field being
   * useless. Left in, it cost 8,996 change events in six days -- 92% of everything the `change`
   * class saw -- and put the time of the last poll into `releaseDate` in Model Facts, which is a
   * wrong fact about a real model. Nothing was ever delivered from them: `created` is a
   * bookkeeping field in `notificationBlock`, which is the only reason this was quiet rather than
   * visible.
   */
  createdIsResponseTime?: boolean;
};

export const PROVIDER_CATALOGUES: ProviderCatalogue[] = [
  {
    id: "xai",
    name: "xAI",
    vendor: "xAI",
    apiUrl: "https://api.x.ai/v1/models",
    url: "https://docs.x.ai/docs/models",
    key: "XAI_API_KEY",
    authority: "first_party",
  },
  {
    id: "zai",
    name: "Z.ai",
    vendor: "Z.ai",
    apiUrl: "https://api.z.ai/api/paas/v4/models",
    url: "https://docs.z.ai/guides/overview/overview",
    key: "ZAI_API_KEY",
    authority: "first_party",
  },
  {
    id: "moonshot",
    name: "Moonshot",
    vendor: "Moonshot",
    apiUrl: "https://api.moonshot.ai/v1/models",
    url: "https://platform.moonshot.ai/docs/pricing",
    key: "MOONSHOT_API_KEY",
    authority: "first_party",
    createdIsResponseTime: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    vendor: "Mistral",
    apiUrl: "https://api.mistral.ai/v1/models",
    url: "https://docs.mistral.ai/getting-started/models/models_overview/",
    key: "MISTRAL_API_KEY",
    authority: "first_party",
    createdIsResponseTime: true,
  },
  {
    id: "groq",
    name: "Groq",
    vendor: "Groq",
    apiUrl: "https://api.groq.com/openai/v1/models",
    url: "https://console.groq.com/docs/models",
    key: "GROQ_API_KEY",
    authority: "first_party",
  },
  // Moonshot serves its coding tier from a separate host with its own key: the general Moonshot
  // key answers with kimi-k2.6 and kimi-k2.7-code and never sees the coding-tier catalogue, which
  // is where a model such as kimi-for-coding is actually listed. Verified 2026-09-14: the address
  // answers 401 to a key it does not accept, so it is the catalogue and not a guess. The source
  // stays uncollected until KIMI_API_KEY is configured.
  {
    id: "kimi",
    name: "Kimi",
    vendor: "Moonshot",
    apiUrl: "https://api.kimi.com/coding/v1/models",
    url: "https://www.kimi.com/code/docs/kimi-code/models.html",
    key: "KIMI_API_KEY",
    authority: "first_party",
  },
  {
    id: "minimax",
    name: "MiniMax",
    vendor: "MiniMax",
    apiUrl: "https://api.minimax.io/v1/models",
    url: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
    key: "MINIMAX_API_KEY",
    authority: "first_party",
  },
  // Alibaba's model studio carries the Qwen catalogue, and lists third-party models it hosts as
  // well; the international host is the one the configured key belongs to.
  {
    id: "dashscope",
    name: "Alibaba Model Studio",
    vendor: "Alibaba",
    apiUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    url: "https://www.alibabacloud.com/help/en/model-studio/models",
    key: "DASHSCOPE_API_KEY",
    authority: "first_party",
  },
  // Cerebras serves open-weight models it did not train, so a new id here is availability rather
  // than a release; it is the first place a hosted open model becomes callable.
  {
    id: "cerebras",
    name: "Cerebras",
    vendor: "Cerebras",
    apiUrl: "https://api.cerebras.ai/v1/models",
    url: "https://inference-docs.cerebras.ai/models/overview",
    key: "CEREBRAS_API_KEY",
    authority: "first_party",
  },
  {
    id: "mimo",
    name: "Xiaomi MiMo",
    vendor: "Xiaomi",
    apiUrl: "https://api.xiaomimimo.com/v1/models",
    url: "https://mimo.mi.com/docs/en-US/api/model/list-models",
    key: "MIMO_API_KEY",
    authority: "first_party",
  },
  {
    id: "poolside",
    name: "Poolside",
    vendor: "Poolside",
    apiUrl: "https://inference.poolside.ai/v1/models",
    url: "https://poolside.ai/models",
    key: "POOLSIDE_API_KEY",
    authority: "first_party",
  },
  // StepFun (阶跃星辰) serves its own Step family and nothing else, so a new id here is a release.
  // Added on 2026-09-20 after Step 5 Preview reached three third-party catalogues before this
  // deployment had any first-party word on it at all.
  {
    id: "stepfun",
    name: "StepFun",
    vendor: "StepFun",
    apiUrl: "https://api.stepfun.com/v1/models",
    url: "https://platform.stepfun.com/docs/llm/text",
    key: "STEPFUN_API_KEY",
    authority: "first_party",
  },
  // Meta lists Muse, SAM and Llama here; "sam-3.1" on 2026-09-18 and the Llama withdrawals of
  // 2026-07-07 were read only by others. The compatibility address answers in OpenAI's shape.
  {
    id: "meta",
    name: "Meta",
    vendor: "Meta",
    apiUrl: "https://api.llama.com/compat/v1/models",
    url: "https://llama.developer.meta.com/docs/models",
    key: "LLAMA_API_KEY",
    authority: "first_party",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    vendor: "DeepInfra",
    apiUrl: "https://api.deepinfra.com/v1/models",
    url: "https://docs.deepinfra.com/",
    key: "DEEPINFRA_API_KEY",
    authority: "third_party",
  },
];

const providerSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        created: z.number().nullish(),
        owned_by: z.string().nullish(),
        // Mistral, Groq, xAI, Moonshot and Poolside add fields OpenAI never defined; they are evidence,
        // not noise. Each names the context window its own way.
        name: z.string().nullish(),
        description: z.string().nullish(),
        max_context_length: z.number().nullish(),
        context_window: z.number().nullish(),
        context_length: z.number().nullish(),
        active: z.boolean().nullish(),
      }),
    )
    .min(1),
  // Alibaba's compatible mode answers in pages and says so here. This collector reads one page, so
  // a catalogue that has another is refused rather than stored as a shrunken one.
  has_more: z.literal(false).nullish(),
});

export async function collectProviderCatalogue(
  provider: ProviderCatalogue,
  config: AppConfig,
  request: Fetch = fetch,
): Promise<Collection> {
  const key = config[provider.key];
  if (typeof key !== "string" || !key) throw new Error(`${provider.name} catalogue needs ${String(provider.key)}`);
  const raw: unknown = JSON.parse(
    await fetchText(provider.apiUrl, { Authorization: `Bearer ${key}`, accept: "application/json" }, request),
  );
  return {
    source: provider.id,
    stream: "api-models",
    url: provider.url,
    raw,
    records: providerSchema.parse(raw).data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      maker: provider.name,
      ...(model.owned_by ? { owner: model.owned_by } : {}),
      ...(model.created && !provider.createdIsResponseTime
        ? { created: new Date(model.created * 1000).toISOString() }
        : {}),
      ...((model.context_window ?? model.max_context_length ?? model.context_length)
        ? { context: model.context_window ?? model.max_context_length ?? model.context_length }
        : {}),
      ...(typeof model.active === "boolean" ? { selectable: model.active } : {}),
    })),
  };
}
