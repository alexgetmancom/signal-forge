import type { Database } from "bun:sqlite";
import type { AppConfig, SourceMode, Stream } from "../config.js";
import { openCredentialCircuitIds } from "../credentials.js";
import { SOURCE_AUTHORITIES } from "../events/confidence.js";
import type { Collection, SourceAuthority } from "../events/types.js";
import { measure } from "../runtime/metrics.js";
import { HttpCache } from "../storage/httpCache.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { collectArtificialAnalysis, collectMediaArena, MEDIA_ARENAS } from "./analysis.js";
import { APP_STORE_APPS, collectAppStore } from "./apps.js";
import { collectArena, collectLeaderboards } from "./arena.js";
import { collectSimpleBench, collectVoxelBench, collectWeirdMl } from "./benchmarks.js";
import {
  collectAnthropic,
  collectGemini,
  collectOpenAI,
  collectOpenRouter,
  collectProviderCatalogue,
  PROVIDER_CATALOGUES,
} from "./catalogs.js";
import { collectClaude } from "./claude.js";
import { collectCodexDocs, collectCodexModels } from "./codex.js";
import { collectCursorChangelog, collectDesignArena, DESIGNARENA_CATEGORIES } from "./community.js";
import { collectDeepSeekModels, collectDeepSeekPricing, collectDeepSeekUpdates } from "./deepseek.js";
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "./deprecations.js";
import { collectGithubDiscovery, collectHuggingFaceTrending, GITHUB_DISCOVERY_QUERIES } from "./discovery.js";
import {
  collectAnthropicSdkReleases,
  collectClaudeCodeChangelog,
  collectDeepMindBlog,
  collectGoogleAiBlog,
  collectHuggingFaceBlogFeed,
  collectNvidiaDeveloperBlog,
  collectOpenAIAlignment,
  collectOpenAICodexChangelog,
} from "./feeds.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "./github.js";
import { sourceLabel } from "./labels.js";
import {
  collectAwsBedrockLifecycle,
  collectAzureFoundryLifecycle,
  collectCohereDeprecations,
  collectGeminiDeprecations,
  collectGroqDeprecations,
  collectVertexDeprecations,
  collectXaiDeprecations,
} from "./lifecycle.js";
import { collectModelsDev, collectTrueFoundryAzure } from "./mirrors.js";
import { collectCohereChangelog } from "./modelDocs.js";
import { collectAnthropicNews, collectClaudeBlog, collectHackerNews, collectOpenAINews } from "./news.js";
import { collectSitePages, WATCHED_SITES } from "./pages.js";
import { collectPlatformStatus, PLATFORMS } from "./platforms.js";
import {
  collectHuggingFace,
  collectHuggingFaceRouter,
  collectNpm,
  collectPypi,
  collectVercelGateway,
  HF_AUTHORS,
  NPM_PACKAGES,
  type NpmChannels,
  PYPI_PACKAGES,
} from "./registries.js";
import {
  collectGeminiApiChangelog,
  collectGroqChangelog,
  collectKimiCodeChangelog,
  collectMiniMaxCodeChangelog,
  collectMistralReleaseNotes,
  collectOpenAIApiChangelog,
  collectOpenAIChatGPTReleaseNotes,
  collectXaiReleaseNotes,
} from "./releaseNotes.js";
import { collectCodexResets } from "./resets.js";
import { collectMimoTraining } from "./training.js";
import { collectOpenRouterUsage } from "./usage.js";
import { collectVertexModelGarden, collectVertexQuotas } from "./vertex.js";

export type SourceDefinition = {
  id: string;
  label: string;
  vendor?: string;
  authority: SourceAuthority;
  group: string;
  stream: Stream;
  intervalSeconds: number;
  capabilityId?: string;
  requiredCapabilities?: readonly string[];
  pace?: { group: string; seconds: number };
  collector: () => Promise<Collection>;
  enabled: boolean;
  mode: SourceMode;
  restrictedReason?: string;
  /** Answers with tens of megabytes; collected one at a time with other heavy sources. */
  heavy?: boolean;
};

/**
 * The one source catalog used to wire polling and status. Dynamic families are still generated
 * from their collector-specific lists, but their operational metadata is defined here beside the
 * static sources.
 */
/** The child sitemaps the last stored read of a site followed, or null when it recorded none. */
function childSitemapsRead(db: Database, source: string): string[] | null {
  const payload = readLatestSnapshot(db, source);
  const children = payload ? (JSON.parse(payload) as { children?: unknown }).children : undefined;
  return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : null;
}

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

export function buildSourceRegistry(db: Database, config: AppConfig): SourceDefinition[] {
  const cache = new HttpCache(db);
  // Label and enabled derive from the id, so an entry cannot name one source and switch another.
  const definitions: Omit<SourceDefinition, "mode" | "label" | "enabled">[] = [
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
      // A bot opens the pull request and it merges within the day; hourly is ahead of the cadence
      // the repository actually changes at, and the tree is one request.
      intervalSeconds: 3600,
      requiredCapabilities: ["GITHUB_TOKEN"],
      collector: () => collectTrueFoundryAzure(config.GITHUB_TOKEN ?? "", fetch, cache),
    },
    {
      id: "openai-news",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAINews(),
    },
    {
      id: "hackernews",
      authority: "third_party",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectHackerNews(),
    },
    {
      id: "openai-chatgpt-release-notes",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAIChatGPTReleaseNotes(fetch, cache),
    },
    {
      id: "openai-codex-changelog",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAICodexChangelog(fetch, cache),
    },
    {
      id: "openai-api-changelog",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      // Answers 304 to a conditional request, measured 2026-09-17, so a poll that finds nothing costs no body.
      intervalSeconds: 900,
      collector: () => collectOpenAIApiChangelog(fetch, cache),
    },
    {
      id: "anthropic-news",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectAnthropicNews(),
    },
    {
      id: "claude-blog",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectClaudeBlog(),
    },
    {
      id: "mimo-training",
      authority: "first_party",
      vendor: "Xiaomi",
      group: "Discovery",
      stream: "training",
      intervalSeconds: 1800,
      collector: () => collectMimoTraining(),
    },
    {
      id: "gemini-api-changelog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectGeminiApiChangelog(fetch, cache),
    },
    {
      id: "xai-release-notes",
      authority: "first_party",
      vendor: "xAI",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectXaiReleaseNotes(fetch, cache),
    },
    {
      id: "mistral-release-notes",
      authority: "first_party",
      vendor: "Mistral",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectMistralReleaseNotes(fetch, cache),
    },
    {
      id: "groq-changelog",
      authority: "first_party",
      vendor: "Groq",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectGroqChangelog(fetch, cache),
    },
    {
      id: "deepseek-updates",
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectDeepSeekUpdates(fetch, cache),
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
      intervalSeconds: config.pollSeconds,
      capabilityId: "deepseek",
      requiredCapabilities: ["DEEPSEEK_API_KEY"],
      collector: () => collectDeepSeekModels(config),
    },
    {
      id: "claude-code-changelog",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectClaudeCodeChangelog(fetch, cache),
    },
    {
      id: "anthropic-sdk-releases",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectAnthropicSdkReleases(fetch, cache),
    },
    {
      id: "huggingface-blog-feed",
      authority: "vendor_owned",
      vendor: "Hugging Face",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectHuggingFaceBlogFeed(fetch, cache),
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
      id: "arena",
      authority: "third_party",
      group: "Arena",
      stream: "arena",
      intervalSeconds: config.pollSeconds,
      collector: () => collectArena(),
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
    {
      id: "arena-leaderboards",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 1800,
      collector: () => collectLeaderboards(),
    },
    {
      id: "codex-docs",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCodexDocs(fetch, cache),
    },
    {
      id: "codex-models",
      authority: "vendor_owned",
      vendor: "OpenAI",
      group: "GitHub",
      stream: "github",
      intervalSeconds: 1800,
      collector: () => collectCodexModels(fetch, cache),
    },
    {
      id: "codex-resets",
      authority: "third_party",
      vendor: "OpenAI",
      group: "Usage limits",
      stream: "resets",
      // Measured over the tracked history: one reset every 6.9 days. A quarter-hour poll is
      // already far finer than the thing it watches.
      intervalSeconds: 900,
      collector: () => collectCodexResets(fetch, cache),
    },
    {
      id: "claude-web",
      // Every JavaScript bundle claude.ai loads, about 22 MB a read.
      heavy: true,
      authority: "first_party",
      vendor: "Anthropic",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectClaude(fetch, cache),
    },
    ...HF_AUTHORS.map(
      (author, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `huggingface:${author}`,
        authority: "vendor_owned",
        group: "Open weights",
        stream: "weights",
        intervalSeconds: 1800 + index * 90,
        pace: { group: "huggingface.co", seconds: 60 },
        collector: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
      }),
    ),
    ...DESIGNARENA_CATEGORIES.map(
      (category, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `designarena:${category}`,
        authority: "third_party",
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
      }),
    ),
    {
      id: "cursor-changelog",
      authority: "first_party",
      vendor: "Cursor",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectCursorChangelog(),
    },
    {
      id: "openai-deprecations",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectOpenAIDeprecations(),
    },
    {
      id: "anthropic-deprecations",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAnthropicDeprecations(),
    },
    {
      id: "gemini-deprecations",
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGeminiDeprecations(),
    },
    {
      id: "vertex-deprecations",
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectVertexDeprecations(),
    },
    {
      id: "aws-bedrock-lifecycle",
      authority: "first_party",
      vendor: "AWS",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAwsBedrockLifecycle(),
    },
    {
      id: "azure-foundry-lifecycle",
      authority: "first_party",
      vendor: "Microsoft",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAzureFoundryLifecycle(),
    },
    {
      id: "groq-deprecations",
      authority: "first_party",
      vendor: "Groq",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGroqDeprecations(),
    },
    {
      id: "cohere-deprecations",
      authority: "first_party",
      vendor: "Cohere",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectCohereDeprecations(),
    },
    {
      id: "xai-deprecations",
      authority: "first_party",
      vendor: "xAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectXaiDeprecations(),
    },
    ...PLATFORMS.map(
      (platform): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `status:${platform.id}`,
        authority: "first_party",
        vendor: platform.name,
        group: "Platform health",
        stream: "incidents",
        intervalSeconds: platform.interval,
        collector: () => collectPlatformStatus(platform),
      }),
    ),
    ...PROVIDER_CATALOGUES.map(
      (provider, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: provider.id,
        authority: provider.authority,
        vendor: provider.vendor,
        group: "Catalogues",
        stream: "api-models",
        intervalSeconds: config.pollSeconds + index * 30,
        capabilityId: provider.id,
        requiredCapabilities: [provider.key],
        collector: () => collectProviderCatalogue(provider, config),
      }),
    ),
    {
      id: "google-ai-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectGoogleAiBlog(fetch, cache),
    },
    {
      id: "deepmind-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // Answers 304 to a conditional request, measured 2026-09-17, so a poll that finds nothing costs no body.
      intervalSeconds: 900,
      collector: () => collectDeepMindBlog(fetch, cache),
    },
    {
      id: "openai-alignment",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAIAlignment(fetch, cache),
    },
    {
      id: "nvidia-developer-blog",
      authority: "first_party",
      vendor: "NVIDIA",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectNvidiaDeveloperBlog(fetch, cache),
    },
    {
      id: "kimi-code-changelog",
      authority: "first_party",
      vendor: "Moonshot",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectKimiCodeChangelog(fetch, cache),
    },
    {
      id: "minimax-code-changelog",
      authority: "first_party",
      vendor: "MiniMax",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectMiniMaxCodeChangelog(fetch, cache),
    },
    {
      id: "cohere-changelog",
      authority: "first_party",
      vendor: "Cohere",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCohereChangelog(fetch, cache),
    },
    {
      id: "voxelbench",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectVoxelBench(fetch, cache),
    },
    {
      id: "weirdml",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectWeirdMl(fetch, cache),
    },
    {
      id: "simplebench",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectSimpleBench(fetch, cache),
    },
    {
      id: "artificial-analysis",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      capabilityId: "artificial-analysis",
      requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
      collector: () => collectArtificialAnalysis(config),
    },
    ...MEDIA_ARENAS.map(
      (arena): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `artificial-analysis:${arena}`,
        authority: "third_party",
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600,
        capabilityId: "artificial-analysis",
        requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
        collector: () => collectMediaArena(config, arena),
      }),
    ),
    ...WATCHED_SITES.map(
      (site, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `pages:${site.id}`,
        authority: "first_party",
        vendor: site.vendor,
        group: "Site pages",
        stream: "pages",
        // One collection reads a site's index and its sections in sequence, so the requests are
        // already paced by the collector itself.
        intervalSeconds: 3600 + index * 300,
        collector: () => collectSitePages(site, fetch, cache, childSitemapsRead(db, `pages:${site.id}`)),
      }),
    ),
    ...APP_STORE_APPS.map(
      (app, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
        id: `app:ios:${app.id}`,
        authority: "vendor_owned",
        vendor: app.vendor,
        group: "Apps",
        stream: "apps",
        // App Store metadata changes a few times a week per app, and one listing is one request.
        intervalSeconds: 1800 + index * 60,
        pace: { group: "itunes.apple.com", seconds: 10 },
        collector: () => collectAppStore(app, fetch, cache),
      }),
    ),
    ...NPM_PACKAGES.map(
      (name, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
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
      (name, index): Omit<SourceDefinition, "mode" | "label" | "enabled"> => ({
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
      intervalSeconds: config.pollSeconds,
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
      intervalSeconds: config.pollSeconds,
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
      intervalSeconds: config.pollSeconds,
      capabilityId: "gemini",
      requiredCapabilities: ["GEMINI_API_KEY"],
      collector: () => collectGemini(config),
      restrictedReason: "upstream is not serving this feed to us — no data reaching the collector",
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
      id: "huggingface-router",
      authority: "third_party",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 900,
      collector: () => collectHuggingFaceRouter(fetch, cache),
    },
  ];

  for (const watch of config.github) {
    const authority = watch.repo.startsWith("deepseek-ai/") ? "vendor_owned" : "third_party";
    definitions.push(
      {
        id: `github:${watch.repo}:pulls`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubPulls(db, config, watch, fetch, cache),
      },
      {
        id: `github:${watch.repo}:commits`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubCommits(db, config, watch, fetch, cache),
      },
      {
        id: `github:${watch.repo}:releases`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
      },
    );
  }

  for (const query of GITHUB_DISCOVERY_QUERIES) {
    definitions.push({
      id: `discovery:github-${query.id}`,
      authority: "third_party",
      group: "Discovery",
      stream: "github",
      intervalSeconds: 3600,
      requiredCapabilities: ["GITHUB_TOKEN"],
      pace: { group: "github-search", seconds: 60 },
      collector: () => collectGithubDiscovery(config, query, fetch, new Date(), cache),
    });
  }
  definitions.push({
    id: "discovery:huggingface-trending",
    authority: "third_party",
    group: "Discovery",
    stream: "weights",
    // The list moves with likes over days, so an hour is early enough to see a model enter it.
    intervalSeconds: 3600,
    pace: { group: "huggingface.co", seconds: 60 },
    collector: () => collectHuggingFaceTrending(config, fetch, cache, new Date()),
  });

  const shadowByDefault = new Set<string>([
    "github:openai/codex:pulls",
    "github:openai/codex:commits",
    ...GITHUB_DISCOVERY_QUERIES.map((query) => `discovery:github-${query.id}`),
    // Two aggregators of other people's catalogues, kept out of the channel until a fortnight of
    // signal-quality says what they are worth. They are the only sight of the cloud deployment
    // layer, and also the only sources here that report a launch without the vendor saying so.
    "models-dev",
    "truefoundry-azure",
    // An engineering blog, not a newsroom. "Async GRPO with LoRA across HF Jobs" is a post about
    // how Hugging Face runs training on its own infrastructure; a reader following model releases
    // gets nothing from it, and it arrived in the invited room beside actual sightings. The feed
    // keeps collecting, because a release post could appear there and the evidence is worth
    // holding; it simply no longer interrupts anyone.
    "huggingface-blog-feed",
    // Collected to be measured against, never to be told: nobody needs a card because a model
    // moved from ninth to tenth by tokens.
    "openrouter-usage",
    // Removed on 2026-09-10 as mostly marketing, back to be measured rather than trusted: it
    // collects, never reaches a channel, and source-verdicts decides after a month.
    "nvidia-developer-blog",
  ]);
  const resolved = definitions.map(
    (definition): SourceDefinition => ({
      ...definition,
      label: sourceLabel(definition.id),
      enabled: config.sourceEnabled[definition.id] ?? true,
      mode: config.sourceMode[definition.id] ?? (shadowByDefault.has(definition.id) ? "shadow" : "active"),
    }),
  );
  const observed = resolved.map(
    (definition): SourceDefinition => ({
      ...definition,
      collector: () => measure(db, `source.collect:${definition.id}`, definition.collector),
    }),
  );
  validateSourceRegistry(observed);
  return observed;
}

export function validateSourceRegistry(definitions: readonly SourceDefinition[]): void {
  const ids = new Set<string>();
  const pacing = new Map<string, number>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate source ID: ${definition.id}`);
    ids.add(definition.id);
    if (!definition.label.trim()) throw new Error(`Source ${definition.id} has no label`);
    if (!definition.group.trim()) throw new Error(`Source ${definition.id} has no group`);
    if (!SOURCE_AUTHORITIES.includes(definition.authority))
      throw new Error(`Source ${definition.id} has invalid authority`);
    // Without a vendor a first-party surface counts as an independent witness to its own vendor.
    if (definition.authority === "first_party" && !definition.vendor?.trim())
      throw new Error(`Source ${definition.id} is first-party and names no vendor`);
    if (definition.mode !== "active" && definition.mode !== "shadow")
      throw new Error(`Source ${definition.id} has invalid mode`);
    if (!Number.isInteger(definition.intervalSeconds) || definition.intervalSeconds <= 0)
      throw new Error(`Source ${definition.id} has an invalid interval`);
    if (definition.pace) {
      if (!definition.pace.group.trim() || !Number.isInteger(definition.pace.seconds) || definition.pace.seconds <= 0)
        throw new Error(`Source ${definition.id} has invalid pacing`);
      const previous = pacing.get(definition.pace.group);
      if (previous !== undefined && previous !== definition.pace.seconds)
        throw new Error(`Pacing group ${definition.pace.group} has conflicting intervals`);
      pacing.set(definition.pace.group, definition.pace.seconds);
    }
  }
}

/**
 * Stores who each source answers for, and with what authority, as the registry says, so projections
 * rebuilt from stored rows read the values the poller collected with rather than a second list.
 */
export function recordSourceIdentities(db: Database, definitions: readonly SourceDefinition[]): void {
  const upsert = db.query(
    "INSERT INTO sources(id,authority,vendor) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET authority=excluded.authority,vendor=excluded.vendor",
  );
  for (const definition of definitions) upsert.run(definition.id, definition.authority, definition.vendor ?? null);
}

/** Scheduler projection: all operational metadata still comes from buildSourceRegistry. */
export function sourceJobs(db: Database, config: AppConfig): SourceDefinition[] {
  const rejected = openCredentialCircuitIds(db);
  return buildSourceRegistry(db, config).filter(
    (definition) =>
      definition.enabled &&
      sourceRequirementsReady(definition, config) &&
      !rejected.has(definition.capabilityId ?? definition.id),
  );
}

export function sourceRequirementsReady(definition: SourceDefinition, config: AppConfig): boolean {
  const values = config as unknown as Record<string, unknown>;
  return (definition.requiredCapabilities ?? []).every((name) => Boolean(values[name]));
}
