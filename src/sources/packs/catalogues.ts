import type { Database } from "bun:sqlite";
import { collectBedrock } from "../bedrock.js";
import {
  collectAnthropic,
  collectGemini,
  collectOpenAI,
  collectOpenRouter,
  collectProviderCatalogue,
  PROVIDER_CATALOGUES,
} from "../catalogs.js";
import { collectDeepSeekModels, collectDeepSeekPricing } from "../deepseek.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectGoogleSkus } from "../googleSkus.js";
import { collectModelsDev, collectTrueFoundryAzure } from "../mirrors.js";
import {
  collectHuggingFace,
  collectHuggingFaceRouter,
  collectNpm,
  collectPypi,
  collectVercelGateway,
  HF_AUTHORS,
  HF_LABS,
  NPM_PACKAGES,
  type NpmChannels,
  PYPI_PACKAGES,
} from "../registries.js";
import { collectOpenRouterUsage } from "../usage.js";
import { collectVertexModelGarden, collectVertexQuotas } from "../vertex.js";

/** The channels a package's accepted records point at, so an unchanged package is read cheaply. */
function npmChannels(db: Database, source: string): NpmChannels {
  const channels: NpmChannels = new Map();
  for (const row of db
    .query<{ id: string; body: string }, [string]>("SELECT id,body FROM records WHERE source=?")
    .all(source)) {
    const body = JSON.parse(row.body) as { version?: unknown; published?: unknown };
    if (typeof body.version === "string" && typeof body.published === "string")
      channels.set(row.id, { version: body.version, published: body.published });
  }
  return channels;
}

/**
 * A maker's own model list is where a release shows first, and the request is one small JSON: MiMo
 * V2.6 appeared between two polls ten minutes apart on 2026-09-21, nine minutes after a rival's post.
 * The few seconds between makers keep their polls from landing together.
 */
const MAKER_API_SECONDS = 120;
/** Hosts serving other makers' open weights: rarely first, so the old pace. */
const HOSTS = new Set(["groq", "cerebras", "deepinfra"]);

/** Model catalogues: vendor APIs, routers, resellers, package registries and open-weight hubs. */
export function cataloguesSources({ db, config, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "openrouter",
      authority: "third_party",
      group: "Catalogues",
      stream: "openrouter",
      intervalSeconds: config.pollSeconds,
      collector: () => collectOpenRouter(),
    },
    {
      id: "models-dev",
      // The whole models.dev catalogue, 4.5 MB.
      heavy: true,
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      collector: () => collectModelsDev(fetch, cache),
    },
    {
      id: "truefoundry-azure",
      authority: "third_party",
      vendor: "Microsoft",
      group: "Catalogues",
      stream: "api-models",
      // It repeats what Azure Foundry and the other catalogues already listed: 42 appearances in the
      // month to 2026-09-22, none of them first, a median eleven days behind. Daily keeps its record.
      intervalSeconds: 86_400,
      requiredCapabilities: ["GITHUB_TOKEN"],
      collector: () => collectTrueFoundryAzure(config.GITHUB_TOKEN ?? "", fetch, cache),
    },
    {
      id: "deepseek-pricing",
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 1800,
      collector: () => collectDeepSeekPricing(fetch, cache),
    },
    {
      id: "deepseek-api",
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: MAKER_API_SECONDS,
      capabilityId: "deepseek",
      requiredCapabilities: ["DEEPSEEK_API_KEY"],
      collector: () => collectDeepSeekModels(config),
    },
    {
      id: "vercel-gateway",
      // A gateway reselling other makers' models: its listing is availability, not a maker's word.
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      collector: () => collectVercelGateway(),
    },
    {
      id: "openrouter-usage",
      authority: "third_party",
      group: "Catalogues",
      stream: "leaderboards",
      // Usage over a month moves slowly; reading it four times a day is already more often than
      // any decision that depends on it.
      intervalSeconds: 21600,
      collector: () => collectOpenRouterUsage(),
    },
    ...HF_AUTHORS.map(
      (author, index): SourceEntry => ({
        id: `huggingface:${author}`,
        authority: "vendor_owned",
        group: "Open weights",
        stream: "weights",
        // A lab's weights often land before its API lists them; the rest are read at the old pace.
        intervalSeconds: HF_LABS.has(author) ? 300 + index * 5 : 1800 + index * 90,
        pace: { group: "huggingface.co", seconds: 10 },
        collector: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
      }),
    ),
    ...PROVIDER_CATALOGUES.map(
      (provider, index): SourceEntry => ({
        id: provider.id,
        authority: provider.authority,
        vendor: provider.vendor,
        group: "Catalogues",
        stream: "api-models",
        intervalSeconds: HOSTS.has(provider.id) ? config.pollSeconds + index * 30 : MAKER_API_SECONDS + index * 3,
        capabilityId: provider.id,
        requiredCapabilities: [provider.key],
        collector: () => collectProviderCatalogue(provider, config),
      }),
    ),
    ...NPM_PACKAGES.map(
      (name, index): SourceEntry => ({
        id: `npm:${name}`,
        authority: "vendor_owned",
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        // Usually 600 bytes; the full document, up to 15 MB, whenever a channel moves.
        heavy: true,
        collector: () => collectNpm(name, fetch, cache, npmChannels(db, `npm:${name}`)),
      }),
    ),
    ...PYPI_PACKAGES.map(
      (name, index): SourceEntry => ({
        id: `pypi:${name}`,
        authority: "vendor_owned",
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        collector: () => collectPypi(name, fetch, cache),
      }),
    ),
    {
      id: "openai",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: MAKER_API_SECONDS,
      capabilityId: "openai",
      requiredCapabilities: ["OPENAI_API_KEY"],
      collector: () => collectOpenAI(config),
    },
    {
      id: "anthropic",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: MAKER_API_SECONDS,
      capabilityId: "anthropic",
      requiredCapabilities: ["ANTHROPIC_API_KEY"],
      collector: () => collectAnthropic(config),
    },
    {
      id: "gemini",
      authority: "first_party",
      vendor: "Google",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: MAKER_API_SECONDS,
      capabilityId: "gemini",
      requiredCapabilities: ["GEMINI_API_KEY"],
      collector: () => collectGemini(config),
    },
    {
      id: "vertex-quotas",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      // Cloud Quotas allows 600 reads a minute and this is one. The page is 1.1 MB with no validator,
      // but it parses to the same bytes when nothing moved, so a poll that finds nothing stores nothing.
      // Measured on production 2026-09-17.
      intervalSeconds: 300,
      capabilityId: "google-cloud",
      requiredCapabilities: ["GOOGLE_CLOUD_SERVICE_ACCOUNT"],
      collector: () => collectVertexQuotas(config),
    },
    {
      id: "vertex-model-garden",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 300,
      capabilityId: "google-cloud",
      requiredCapabilities: ["GOOGLE_CLOUD_SERVICE_ACCOUNT"],
      collector: () => collectVertexModelGarden(config),
    },
    {
      id: "google-skus",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 3600,
      capabilityId: "google-cloud",
      requiredCapabilities: ["GOOGLE_CLOUD_SERVICE_ACCOUNT"],
      collector: () => collectGoogleSkus(config),
    },
    {
      id: "bedrock",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      // Sixteen signed reads, one per region, each a few kilobytes.
      intervalSeconds: 900,
      capabilityId: "aws",
      requiredCapabilities: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      collector: () => collectBedrock(config),
    },
    {
      id: "huggingface-router",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 900,
      collector: () => collectHuggingFaceRouter(fetch, cache),
    },
  ];
}
