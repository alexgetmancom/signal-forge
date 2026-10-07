import type { Database } from "bun:sqlite";
import type { HttpCache } from "../../storage/httpCache.js";
import { collectAnthropicPricing } from "../anthropicPricing.js";
import { collectAntigravityBuild } from "../antigravity.js";
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
import { acceptedEtagUnchanged } from "../http.js";
import { collectKaggleModels } from "../kaggle.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectModelsDev, collectTrueFoundryAzure, MODELS_DEV_URL } from "../mirrors.js";
import { collectClaudeModelCatalog } from "../modelCatalog.js";
import { collectAnthropicModelIndex, collectOpenAIModelIndex } from "../modelIndex.js";
import { collectOpenAIPricing } from "../openaiDocs.js";
import {
  collectHuggingFace,
  collectHuggingFaceRouter,
  collectNpm,
  collectPypi,
  collectVercelGateway,
  HF_AUTHORS,
  HF_LABS,
  NPM_PACKAGES,
  npmUnchanged,
  PYPI_PACKAGES,
} from "../registries.js";
import { collectOpenRouterUsage } from "../usage.js";
import { collectVertexModelGarden, collectVertexQuotas } from "../vertex.js";

/**
 * A maker's own catalogue for its own clients, which is not its API's answer and is not a
 * third party's view either: `claude-opus-4-1-20250805` is offered here and absent from this
 * account's `/v1/models`. `availability_catalogue` and `supported` say that -- a model listed
 * here is one Anthropic offers a client, not one this service has been told it may call.
 *
 * Hourly: it is signed, 147 KB, and moved 110 versions in the day it was first read, so it is
 * the cheapest first-party sighting here and the one most likely to move between polls.
 */
const CLIENT_CATALOGUE: SourceKind = {
  kind: "client-catalogue",
  authority: "first_party",
  evidence: "availability_catalogue",
  confidence: "supported",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: 3600,
};

function claudeClientCatalogue(db: Database): SourceEntry[] {
  return sourcesOfKind(CLIENT_CATALOGUE, [
    { id: "claude-model-catalog", vendor: "Anthropic", collector: () => collectClaudeModelCatalog(db) },
  ]);
}

/**
 * A maker's own model list is where a release shows first, and the request is one small JSON: MiMo
 * V2.6 appeared between two polls ten minutes apart on 2026-09-21, nine minutes after a rival's post.
 * The few seconds between makers keep their polls from landing together.
 *
 * One minute, down from two, because the cycle can carry it and nothing upstream objects: the poller
 * wakes every thirty seconds, so an interval is honoured to within a tick -- the `openai`, `anthropic`
 * and `gemini` rows sat 132 to 149 seconds apart on 2026-10-07, which is the two minutes asked for.
 * One small JSON per maker per minute is 1,440 requests a day against endpoints that have answered
 * 429 to this service zero times, and a `/v1/models` list is the cheapest call either vendor serves.
 * Whatever the halving is worth, it is worth it here: this is the surface the maker itself answers
 * with, and `confidenceFor` reads that as confirmed, so it is the one poll that ends a race.
 */
const MAKER_API_SECONDS = 60;
/** Hosts serving other makers' open weights: rarely first, so the old pace. */
const HOSTS = new Set(["groq", "cerebras", "deepinfra"]);

/**
 * A provider catalogue's pace: a maker reading out its own roster is read at the maker's pace, a
 * host reselling somebody else's weights at whatever the config asks for. Staggered by index so
 * thirty of them do not leave together.
 */
const providerInterval = (id: string, index: number, fallback: number): number =>
  HOSTS.has(id) ? fallback + index * 30 : MAKER_API_SECONDS + index * 3;

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
 * One minute, because this is the whole point of it. These pages are 12 and 17 KB, and on
 * 2026-09-29 the fifteen minutes between polls of a changelog was the entire margin by which this
 * tracker came second on GPT-6.1 Sol. It was two, and two is what a thirty-second cycle delivered;
 * the page is small enough that the only thing a minute costs is the request, so it reads at the
 * same pace as the API of the maker who writes it.
 */
const MODEL_INDEX: SourceKind = {
  kind: "model-index",
  authority: "first_party",
  evidence: "web_diff",
  confidence: "supported",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: MAKER_API_SECONDS,
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

/**
 * The hubs a maker uploads weights to, which is a different question from what its API will serve.
 *
 * Its own function because `cataloguesSources` is at its size budget and this is the part of it
 * that is about hubs rather than catalogues.
 */
function openWeightsSources({ config, cache }: SourceContext): SourceEntry[] {
  return [
    ...sourcesOfKind(OPEN_WEIGHTS_ACCOUNT, [
      /**
       * Google's Kaggle cards, through the API its published SDK dispatches to.
       *
       * Hourly rather than every half hour because nothing here is ever new: on 2026-10-04 the
       * owner's most recent card was a month old and its two proprietary entries, `gemini-3-pro-api`
       * and `gemini-3-flash-api`, were ten months behind the API catalogue. Read for coverage of
       * the open side, never as an early sighting; ../kaggle.ts carries the measurement.
       */
      {
        id: "kaggle:google",
        vendor: "Google",
        intervalSeconds: 3600,
        // 4.2 MB of card descriptions and 1,460 framework variants, measured 2026-10-04.
        heavy: true,
        pace: { group: "api.kaggle.com", seconds: 10 },
        collector: () => collectKaggleModels("google", fetch, cache),
      },
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
    intervalSeconds: providerInterval(provider.id, index, config.defaultIntervalSeconds),
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
      intervalSeconds: config.defaultIntervalSeconds,
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
    ...claudeClientCatalogue(db),
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
      /**
       * The price a maker charges for its own models, which no catalogue can answer for: a reseller
       * quotes what it charges. A new row is a model priced before it is announced, and a changed
       * one is a price cut, which for a reader paying for Codex is the news itself.
       */
      {
        id: "openai-pricing",
        vendor: "OpenAI",
        pace: { group: "discovery:docs-openai", seconds: 5 },
        intervalSeconds: 900,
        collector: () => collectOpenAIPricing(fetch, cache),
      },
      // A price list rather than a model list: the same maker's own word, read half-hourly.
      {
        id: "deepseek-pricing",
        vendor: "DeepSeek",
        intervalSeconds: 1800,
        collector: () => collectDeepSeekPricing(fetch, cache),
      },
      // The third of them, and the only price for a Claude model that is not a reseller quoting
      // itself. `/v1/models` prices nothing, so this is the documentation table.
      {
        id: "anthropic-pricing",
        vendor: "Anthropic",
        // Ten minutes, so a launch card has a chance of carrying the price in its first printing
        // rather than only in the amendment that follows. The page serves `last-modified` and
        // ignores `if-modified-since`, so there is no cheap half and every read is the whole 49 KB;
        // bytes are not the limit here, the host's patience is, which is what the pace group below
        // is for. `platform.claude.com` has answered 429 to this service zero times.
        intervalSeconds: 600,
        pace: { group: "discovery:docs-anthropic", seconds: 5 },
        collector: () => collectAnthropicPricing(fetch, cache),
      },
      ...providers.filter((provider) => provider.authority === "first_party"),
    ]),
    ...modelIndexSources(cache),
    ...sourcesOfKind(RESELLER_CATALOGUE, [
      // HEAD checks the accepted ETag here; the 5.3 MB catalogue is parsed only when it moves.
      {
        id: "models-dev",
        heavy: true,
        intervalSeconds: config.defaultIntervalSeconds,
        nothingNew: () => acceptedEtagUnchanged(db, cache, "models-dev", MODELS_DEV_URL),
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
      { id: "vercel-gateway", intervalSeconds: config.defaultIntervalSeconds, collector: () => collectVercelGateway() },
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
        nothingNew: () => npmUnchanged(db, name),
        collector: () => collectNpm(name, fetch, cache),
      })),
      ...PYPI_PACKAGES.map((name, index) => ({
        id: `pypi:${name}`,
        intervalSeconds: 900 + index * 45,
        collector: () => collectPypi(name, fetch, cache),
      })),
      /**
       * What the Antigravity CLI's own updater offers, which is the build before the changelog
       * says so: 1.2.16 in both manifests on 2026-10-04 against 1.2.14 in the published changelog.
       * Two reads of 303 bytes, so it is paced with the registries rather than given a budget.
       */
      { id: "antigravity-cli-build", vendor: "Google", collector: () => collectAntigravityBuild(fetch, cache) },
    ]),
    ...openWeightsSources({ db, config, cache }),
  ];
}
