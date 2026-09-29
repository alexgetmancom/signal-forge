import type { Database } from "bun:sqlite";
import type { HttpCache } from "../../storage/httpCache.js";
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
import { type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectModelsDev, collectTrueFoundryAzure } from "../mirrors.js";
import { collectAnthropicModelIndex, collectOpenAIModelIndex } from "../modelIndex.js";
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

/**
 * A maker's own account on an open-weights hub, read for the repository that appears before any
 * announcement links to it.
 *
 * `vendor_owned` rather than `first_party`: the account belongs to the maker, the hub does not, and
 * what is observed is the hub's view of it. Nineteen accounts shared these four fields verbatim.
 */
const OPEN_WEIGHTS_ACCOUNT: SourceKind = {
  kind: "open-weights-account",
  appendOnly: true,
  authority: "vendor_owned",
  // A hub entry is the maker's own upload but not the maker's own word about it: the files are
  // there, and whether the model is out is a separate question the account never answers.
  evidence: "open_weights",
  confidence: "supported",
  group: "Open weights",
  stream: "weights",
  // Overruled per member: a lab that ships weights before its API lists them is worth five minutes,
  // and the rest are read at the old half-hour. The hub is asked no faster than once every ten
  // seconds however many accounts are due, which is why the pace is fixed here rather than per member.
  intervalSeconds: 1800,
  pace: { group: "huggingface.co", seconds: 10 },
};

/**
 * A maker's own model list, where its own release shows first.
 *
 * Eighteen sources repeated these four fields. `first_party` is the point of the kind: the maker is
 * answering for its own product, which is what `confidenceFor` reads to call a listing confirmed.
 */
const MAKER_API: SourceKind = {
  kind: "maker-api",
  authority: "first_party",
  // The maker answering for its own product, which is the whole reason a listing here is confirmed.
  evidence: "api_catalogue",
  confidence: "confirmed",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: MAKER_API_SECONDS,
};

/**
 * Somebody else's catalogue of a maker's models: a router, a cloud, a gateway, a mirror.
 *
 * `third_party` for the reason spelled out in `evidenceTypeFor`: who sells a model is a different
 * fact from what its maker publishes, and a reseller listing is availability rather than a word
 * from the maker. Most of these are never first, so the default pace is the poll cycle and the
 * members that cost more overrule it.
 */
const RESELLER_CATALOGUE: SourceKind = {
  kind: "reseller-catalogue",
  authority: "third_party",
  // Who sells a model is a different fact from what its maker publishes, so the evidence is
  // availability and the listing stands alone until somebody with authority says the same.
  evidence: "availability_catalogue",
  confidence: "observed",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: 900,
};

/**
 * A maker's own index of the models it documents.
 *
 * Not its API and not its newsroom: the page that lists every model page, which is the first place
 * a new model is named in writing. `supported` rather than `confirmed` for the reason the developer
 * feeds carry -- a documented model is the maker saying it exists, and whether it can be called is
 * a catalogue's business -- and `web_diff` because what was read is a page, not a model list an API
 * answers with.
 *
 * Two minutes, because this is the whole point of it. These pages are 12 and 17 KB, and on
 * 2026-09-29 the fifteen minutes between polls of a changelog was the entire margin by which this
 * tracker came second on GPT-6.1 Sol.
 */
const MODEL_INDEX: SourceKind = {
  kind: "model-index",
  authority: "first_party",
  evidence: "web_diff",
  confidence: "supported",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: 120,
};

/**
 * The two makers whose own documentation index is read.
 *
 * Each shares its pacing group with the documentation probe, because each shares its host: the
 * probe asks `platform.openai.com`, which is this host under its old name, and it asks
 * `platform.claude.com`, which is where the Anthropic overview lives. A group is a host, whatever
 * the source that first named it.
 */
function modelIndexSources(cache: HttpCache): SourceEntry[] {
  return sourcesOfKind(MODEL_INDEX, [
    {
      id: "openai-model-index",
      vendor: "OpenAI",
      pace: { group: "discovery:docs-openai", seconds: 5 },
      collector: () => collectOpenAIModelIndex(fetch, cache),
    },
    {
      id: "anthropic-model-index",
      vendor: "Anthropic",
      pace: { group: "discovery:docs-anthropic", seconds: 5 },
      collector: () => collectAnthropicModelIndex(fetch, cache),
    },
  ]);
}

/**
 * A published package of a maker's own tooling, which is the moment a reader can install it.
 *
 * `vendor_owned`: the registry is not the maker, but a version appearing under the maker's name is
 * the maker shipping. The staggered pace keeps sixteen of these off the same minute.
 */
const PACKAGE_REGISTRY: SourceKind = {
  kind: "package-registry",
  authority: "vendor_owned",
  // A version under the maker's name in a registry is installable, which is as confirmed as
  // anything here gets.
  evidence: "package_release",
  confidence: "confirmed",
  group: "Packages",
  stream: "packages",
  intervalSeconds: 900,
};

/** Model catalogues: vendor APIs, routers, resellers, package registries and open-weight hubs. */
export function cataloguesSources({ db, config, cache }: SourceContext): SourceEntry[] {
  /**
   * The provider catalogues, paced before they are split by authority: the stagger is an index into
   * the one list, so partitioning first would move every interval after the first reseller.
   */
  const providers = PROVIDER_CATALOGUES.map((provider, index) => ({
    id: provider.id,
    authority: provider.authority,
    vendor: provider.vendor,
    intervalSeconds: HOSTS.has(provider.id) ? config.pollSeconds + index * 30 : MAKER_API_SECONDS + index * 3,
    capabilityId: provider.id,
    requiredCapabilities: [provider.key],
    collector: () => collectProviderCatalogue(provider, config),
  }));
  return [
    {
      id: "openrouter",
      authority: "third_party",
      // One router reselling every maker: availability, and nobody's word but the router's.
      evidence: "availability_catalogue",
      confidence: "observed",
      group: "Catalogues",
      // Its own stream: one router's answer carries every maker at once, which nothing else here does.
      stream: "openrouter",
      intervalSeconds: config.pollSeconds,
      collector: () => collectOpenRouter(),
    },
    {
      id: "openrouter-usage",
      appendOnly: true,
      authority: "third_party",
      // Which models are called, not which exist: a ranking, and never evidence that anything shipped.
      evidence: "leaderboard",
      confidence: "observed",
      group: "Catalogues",
      stream: "leaderboards",
      // Usage over a month moves slowly; reading it four times a day is already more often than
      // any decision that depends on it.
      intervalSeconds: 21600,
      collector: () => collectOpenRouterUsage(),
    },
    ...sourcesOfKind(MAKER_API, [
      {
        id: "openai",
        vendor: "OpenAI",
        capabilityId: "openai",
        requiredCapabilities: ["OPENAI_API_KEY"],
        collector: () => collectOpenAI(config),
      },
      {
        id: "anthropic",
        vendor: "Anthropic",
        capabilityId: "anthropic",
        requiredCapabilities: ["ANTHROPIC_API_KEY"],
        collector: () => collectAnthropic(config),
      },
      {
        id: "gemini",
        vendor: "Google",
        capabilityId: "gemini",
        requiredCapabilities: ["GEMINI_API_KEY"],
        collector: () => collectGemini(config),
      },
      {
        id: "deepseek-api",
        vendor: "DeepSeek",
        capabilityId: "deepseek",
        requiredCapabilities: ["DEEPSEEK_API_KEY"],
        collector: () => collectDeepSeekModels(config),
      },
      // A price list rather than a model list: the same maker's own word, read half-hourly.
      {
        id: "deepseek-pricing",
        vendor: "DeepSeek",
        intervalSeconds: 1800,
        collector: () => collectDeepSeekPricing(fetch, cache),
      },
      ...providers.filter((provider) => provider.authority === "first_party"),
    ]),
    ...modelIndexSources(cache),
    ...sourcesOfKind(RESELLER_CATALOGUE, [
      // The whole models.dev catalogue, 4.5 MB.
      {
        id: "models-dev",
        heavy: true,
        intervalSeconds: config.pollSeconds,
        collector: () => collectModelsDev(fetch, cache),
      },
      {
        id: "truefoundry-azure",
        vendor: "Microsoft",
        // It repeats what Azure Foundry and the other catalogues already listed: 42 appearances in the
        // month to 2026-09-22, none of them first, a median eleven days behind. Daily keeps its record.
        intervalSeconds: 86_400,
        requiredCapabilities: ["GITHUB_TOKEN"],
        collector: () => collectTrueFoundryAzure(config.GITHUB_TOKEN ?? "", fetch, cache),
      },
      // A gateway reselling other makers' models: its listing is availability, not a maker's word.
      { id: "vercel-gateway", intervalSeconds: config.pollSeconds, collector: () => collectVercelGateway() },
      {
        id: "vertex-quotas",
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
        intervalSeconds: 300,
        capabilityId: "google-cloud",
        requiredCapabilities: ["GOOGLE_CLOUD_SERVICE_ACCOUNT"],
        collector: () => collectVertexModelGarden(config),
      },
      {
        id: "google-skus",
        intervalSeconds: 3600,
        capabilityId: "google-cloud",
        requiredCapabilities: ["GOOGLE_CLOUD_SERVICE_ACCOUNT"],
        collector: () => collectGoogleSkus(config),
      },
      {
        id: "bedrock",
        // Sixteen signed reads, one per region, each a few kilobytes.
        intervalSeconds: 900,
        capabilityId: "aws",
        requiredCapabilities: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        collector: () => collectBedrock(config),
      },
      { id: "huggingface-router", appendOnly: true, collector: () => collectHuggingFaceRouter(fetch, cache) },
      ...providers.filter((provider) => provider.authority !== "first_party"),
    ]),
    ...sourcesOfKind(PACKAGE_REGISTRY, [
      ...NPM_PACKAGES.map((name, index) => ({
        id: `npm:${name}`,
        intervalSeconds: 900 + index * 45,
        // Usually 600 bytes; the full document, up to 15 MB, whenever a channel moves.
        heavy: true,
        collector: () => collectNpm(name, fetch, cache, npmChannels(db, `npm:${name}`)),
      })),
      ...PYPI_PACKAGES.map((name, index) => ({
        id: `pypi:${name}`,
        intervalSeconds: 900 + index * 45,
        collector: () => collectPypi(name, fetch, cache),
      })),
    ]),
    ...sourcesOfKind(
      OPEN_WEIGHTS_ACCOUNT,
      HF_AUTHORS.map((author, index) => ({
        id: `huggingface:${author}`,
        // A lab's weights often land before its API lists them; the rest are read at the old pace.
        intervalSeconds: HF_LABS.has(author) ? 300 + index * 5 : 1800 + index * 90,
        collector: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
      })),
    ),
  ];
}
