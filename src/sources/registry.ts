import type { Database } from "bun:sqlite";
import type { AppConfig, SourceMode, Stream } from "../config.js";
import { SOURCE_AUTHORITIES } from "../events/confidence.js";
import type { Collection, SourceAuthority } from "../events/types.js";
import { measure } from "../runtime/metrics.js";
import { HttpCache } from "../storage/httpCache.js";
import { APP_STORE_APPS, collectAppStore } from "./apps.js";
import { collectArena, collectLeaderboards } from "./arena.js";
import { collectAnthropic, collectGemini, collectOpenAI, collectOpenRouter } from "./catalogs.js";
import { collectClaude } from "./claude.js";
import { collectCodexDocs } from "./codex.js";
import { collectCursorChangelog, collectDesignArena, DESIGNARENA_CATEGORIES } from "./community.js";
import { collectDeepSeekModels, collectDeepSeekPricing, collectDeepSeekUpdates } from "./deepseek.js";
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "./deprecations.js";
import { collectGithubDiscovery, collectHuggingFaceDiscovery, GITHUB_DISCOVERY_QUERIES } from "./discovery.js";
import {
  collectAnthropicSdkReleases,
  collectClaudeCodeChangelog,
  collectHuggingFaceBlogFeed,
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
import { collectAnthropicNews, collectOpenAINews } from "./news.js";
import { collectSitePages, WATCHED_SITES } from "./pages.js";
import { collectPlatformStatus, PLATFORMS } from "./platforms.js";
import {
  collectHuggingFace,
  collectNpm,
  collectPypi,
  collectVercelGateway,
  HF_AUTHORS,
  NPM_PACKAGES,
  PYPI_PACKAGES,
} from "./registries.js";
import {
  collectGeminiApiChangelog,
  collectGroqChangelog,
  collectMistralReleaseNotes,
  collectOpenAIApiChangelog,
  collectOpenAIChatGPTReleaseNotes,
  collectXaiReleaseNotes,
} from "./releaseNotes.js";

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
};

export type SourceJob = SourceDefinition & {
  /** Compatibility projection for the scheduler; interval remains registry-owned. */
  interval: number;
  run: SourceDefinition["collector"];
};

/**
 * The one source catalog used to wire polling and status. Dynamic families are still generated
 * from their collector-specific lists, but their operational metadata is defined here beside the
 * static sources.
 */
export function buildSourceRegistry(db: Database, config: AppConfig): SourceDefinition[] {
  const cache = new HttpCache(db);
  const requested = (id: string): boolean => config.sourceEnabled[id] ?? true;
  const definitions: Omit<SourceDefinition, "mode">[] = [
    {
      id: "openrouter",
      label: sourceLabel("openrouter"),
      authority: "third_party",
      group: "Catalogues",
      stream: "openrouter",
      intervalSeconds: config.pollSeconds,
      collector: () => collectOpenRouter(),
      enabled: requested("openrouter"),
    },
    {
      id: "openai-news",
      label: sourceLabel("openai-news"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAINews(),
      enabled: requested("openai-news"),
    },
    {
      id: "openai-chatgpt-release-notes",
      label: sourceLabel("openai-chatgpt-release-notes"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAIChatGPTReleaseNotes(fetch, cache),
      enabled: requested("openai-chatgpt-release-notes"),
    },
    {
      id: "openai-codex-changelog",
      label: sourceLabel("openai-codex-changelog"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAICodexChangelog(fetch, cache),
      enabled: requested("openai-codex-changelog"),
    },
    {
      id: "openai-api-changelog",
      label: sourceLabel("openai-api-changelog"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAIApiChangelog(fetch, cache),
      enabled: requested("openai-api-changelog"),
    },
    {
      id: "anthropic-news",
      label: sourceLabel("anthropic-news"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectAnthropicNews(),
      enabled: requested("anthropic-news"),
    },
    {
      id: "gemini-api-changelog",
      label: sourceLabel("gemini-api-changelog"),
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectGeminiApiChangelog(fetch, cache),
      enabled: requested("gemini-api-changelog"),
    },
    {
      id: "xai-release-notes",
      label: sourceLabel("xai-release-notes"),
      authority: "first_party",
      vendor: "xAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectXaiReleaseNotes(fetch, cache),
      enabled: requested("xai-release-notes"),
    },
    {
      id: "mistral-release-notes",
      label: sourceLabel("mistral-release-notes"),
      authority: "first_party",
      vendor: "Mistral",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectMistralReleaseNotes(fetch, cache),
      enabled: requested("mistral-release-notes"),
    },
    {
      id: "groq-changelog",
      label: sourceLabel("groq-changelog"),
      authority: "first_party",
      vendor: "Groq",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectGroqChangelog(fetch, cache),
      enabled: requested("groq-changelog"),
    },
    {
      id: "deepseek-updates",
      label: sourceLabel("deepseek-updates"),
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectDeepSeekUpdates(fetch, cache),
      enabled: requested("deepseek-updates"),
    },
    {
      id: "deepseek-pricing",
      label: sourceLabel("deepseek-pricing"),
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 1800,
      collector: () => collectDeepSeekPricing(fetch, cache),
      enabled: requested("deepseek-pricing"),
    },
    {
      id: "deepseek-api",
      label: sourceLabel("deepseek-api"),
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      capabilityId: "deepseek",
      requiredCapabilities: ["DEEPSEEK_API_KEY"],
      collector: () => collectDeepSeekModels(config),
      enabled: requested("deepseek-api"),
    },
    {
      id: "claude-code-changelog",
      label: sourceLabel("claude-code-changelog"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectClaudeCodeChangelog(fetch, cache),
      enabled: requested("claude-code-changelog"),
    },
    {
      id: "anthropic-sdk-releases",
      label: sourceLabel("anthropic-sdk-releases"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectAnthropicSdkReleases(fetch, cache),
      enabled: requested("anthropic-sdk-releases"),
    },
    {
      id: "huggingface-blog-feed",
      label: sourceLabel("huggingface-blog-feed"),
      authority: "vendor_owned",
      vendor: "Hugging Face",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectHuggingFaceBlogFeed(fetch, cache),
      enabled: requested("huggingface-blog-feed"),
    },
    {
      id: "vercel-gateway",
      label: sourceLabel("vercel-gateway"),
      authority: "vendor_owned",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      collector: () => collectVercelGateway(),
      enabled: requested("vercel-gateway"),
    },
    {
      id: "arena",
      label: sourceLabel("arena"),
      authority: "third_party",
      group: "Arena",
      stream: "arena",
      intervalSeconds: config.pollSeconds,
      collector: () => collectArena(),
      enabled: requested("arena"),
    },
    {
      id: "arena-leaderboards",
      label: sourceLabel("arena-leaderboards"),
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 1800,
      collector: () => collectLeaderboards(),
      enabled: requested("arena-leaderboards"),
    },
    {
      id: "codex-docs",
      label: sourceLabel("codex-docs"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCodexDocs(fetch, cache),
      enabled: requested("codex-docs"),
    },
    {
      id: "claude-web",
      label: sourceLabel("claude-web"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectClaude(fetch, cache),
      enabled: requested("claude-web"),
    },
    ...HF_AUTHORS.map(
      (author, index): Omit<SourceDefinition, "mode"> => ({
        id: `huggingface:${author}`,
        label: sourceLabel(`huggingface:${author}`),
        authority: "vendor_owned",
        group: "Open weights",
        stream: "weights",
        intervalSeconds: 1800 + index * 90,
        pace: { group: "huggingface.co", seconds: 60 },
        collector: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
        enabled: requested(`huggingface:${author}`),
      }),
    ),
    ...DESIGNARENA_CATEGORIES.map(
      (category, index): Omit<SourceDefinition, "mode"> => ({
        id: `designarena:${category}`,
        label: sourceLabel(`designarena:${category}`),
        authority: "third_party",
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
        enabled: requested(`designarena:${category}`),
      }),
    ),
    {
      id: "cursor-changelog",
      label: sourceLabel("cursor-changelog"),
      authority: "first_party",
      vendor: "Cursor",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectCursorChangelog(),
      enabled: requested("cursor-changelog"),
    },
    {
      id: "openai-deprecations",
      label: sourceLabel("openai-deprecations"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectOpenAIDeprecations(),
      enabled: requested("openai-deprecations"),
    },
    {
      id: "anthropic-deprecations",
      label: sourceLabel("anthropic-deprecations"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAnthropicDeprecations(),
      enabled: requested("anthropic-deprecations"),
    },
    {
      id: "gemini-deprecations",
      label: sourceLabel("gemini-deprecations"),
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGeminiDeprecations(),
      enabled: requested("gemini-deprecations"),
    },
    {
      id: "vertex-deprecations",
      label: sourceLabel("vertex-deprecations"),
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectVertexDeprecations(),
      enabled: requested("vertex-deprecations"),
    },
    {
      id: "aws-bedrock-lifecycle",
      label: sourceLabel("aws-bedrock-lifecycle"),
      authority: "first_party",
      vendor: "AWS",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAwsBedrockLifecycle(),
      enabled: requested("aws-bedrock-lifecycle"),
    },
    {
      id: "azure-foundry-lifecycle",
      label: sourceLabel("azure-foundry-lifecycle"),
      authority: "first_party",
      vendor: "Microsoft",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAzureFoundryLifecycle(),
      enabled: requested("azure-foundry-lifecycle"),
    },
    {
      id: "groq-deprecations",
      label: sourceLabel("groq-deprecations"),
      authority: "first_party",
      vendor: "Groq",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGroqDeprecations(),
      enabled: requested("groq-deprecations"),
    },
    {
      id: "cohere-deprecations",
      label: sourceLabel("cohere-deprecations"),
      authority: "first_party",
      vendor: "Cohere",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectCohereDeprecations(),
      enabled: requested("cohere-deprecations"),
    },
    {
      id: "xai-deprecations",
      label: sourceLabel("xai-deprecations"),
      authority: "first_party",
      vendor: "xAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectXaiDeprecations(),
      enabled: requested("xai-deprecations"),
    },
    ...PLATFORMS.map(
      (platform): Omit<SourceDefinition, "mode"> => ({
        id: `status:${platform.id}`,
        label: sourceLabel(`status:${platform.id}`),
        authority: "first_party",
        vendor: platform.name,
        group: "Platform health",
        stream: "incidents",
        intervalSeconds: platform.interval,
        collector: () => collectPlatformStatus(platform),
        enabled: requested(`status:${platform.id}`),
      }),
    ),
    ...WATCHED_SITES.map(
      (site, index): Omit<SourceDefinition, "mode"> => ({
        id: `pages:${site.id}`,
        label: sourceLabel(`pages:${site.id}`),
        authority: "first_party",
        vendor: site.vendor,
        group: "Site pages",
        stream: "pages",
        // One collection reads a site's index and its sections in sequence, so the requests are
        // already paced by the collector itself.
        intervalSeconds: 3600 + index * 300,
        collector: () => collectSitePages(site, fetch, cache),
        enabled: requested(`pages:${site.id}`),
      }),
    ),
    ...APP_STORE_APPS.map(
      (app, index): Omit<SourceDefinition, "mode"> => ({
        id: `app:ios:${app.id}`,
        label: sourceLabel(`app:ios:${app.id}`),
        authority: "vendor_owned",
        vendor: app.vendor,
        group: "Apps",
        stream: "apps",
        // App Store metadata changes a few times a week per app, and one listing is one request.
        intervalSeconds: 1800 + index * 60,
        pace: { group: "itunes.apple.com", seconds: 10 },
        collector: () => collectAppStore(app, fetch, cache),
        enabled: requested(`app:ios:${app.id}`),
      }),
    ),
    ...NPM_PACKAGES.map(
      (name, index): Omit<SourceDefinition, "mode"> => ({
        id: `npm:${name}`,
        label: sourceLabel(`npm:${name}`),
        authority: "vendor_owned",
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        collector: () => collectNpm(name, fetch, cache),
        enabled: requested(`npm:${name}`),
      }),
    ),
    ...PYPI_PACKAGES.map(
      (name, index): Omit<SourceDefinition, "mode"> => ({
        id: `pypi:${name}`,
        label: sourceLabel(`pypi:${name}`),
        authority: "vendor_owned",
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        collector: () => collectPypi(name, fetch, cache),
        enabled: requested(`pypi:${name}`),
      }),
    ),
    {
      id: "openai",
      label: sourceLabel("openai"),
      authority: "first_party",
      vendor: "OpenAI",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      capabilityId: "openai",
      requiredCapabilities: ["OPENAI_API_KEY"],
      collector: () => collectOpenAI(config),
      enabled: requested("openai"),
    },
    {
      id: "anthropic",
      label: sourceLabel("anthropic"),
      authority: "first_party",
      vendor: "Anthropic",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      capabilityId: "anthropic",
      requiredCapabilities: ["ANTHROPIC_API_KEY"],
      collector: () => collectAnthropic(config),
      enabled: requested("anthropic"),
    },
    {
      id: "gemini",
      label: sourceLabel("gemini"),
      authority: "first_party",
      vendor: "Google",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      capabilityId: "gemini",
      requiredCapabilities: ["GEMINI_API_KEY"],
      collector: () => collectGemini(config),
      enabled: requested("gemini"),
      restrictedReason: "upstream is not serving this feed to us — no data reaching the collector",
    },
  ];

  for (const watch of config.github) {
    const authority = watch.repo.startsWith("deepseek-ai/") ? "vendor_owned" : "third_party";
    definitions.push(
      {
        id: `github:${watch.repo}:pulls`,
        label: sourceLabel(`github:${watch.repo}:pulls`),
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubPulls(db, config, watch, fetch, cache),
        enabled: requested(`github:${watch.repo}:pulls`),
      },
      {
        id: `github:${watch.repo}:commits`,
        label: sourceLabel(`github:${watch.repo}:commits`),
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubCommits(db, config, watch, fetch, cache),
        enabled: requested(`github:${watch.repo}:commits`),
      },
      {
        id: `github:${watch.repo}:releases`,
        label: sourceLabel(`github:${watch.repo}:releases`),
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
        enabled: requested(`github:${watch.repo}:releases`),
      },
    );
  }

  for (const query of GITHUB_DISCOVERY_QUERIES) {
    definitions.push({
      id: `discovery:github-${query.id}`,
      label: sourceLabel(`discovery:github-${query.id}`),
      authority: "third_party",
      group: "Discovery",
      stream: "github",
      intervalSeconds: 3600,
      requiredCapabilities: ["GITHUB_TOKEN"],
      pace: { group: "github-search", seconds: 60 },
      collector: () => collectGithubDiscovery(config, query, fetch, new Date(), cache),
      enabled: requested(`discovery:github-${query.id}`),
    });
  }
  definitions.push({
    id: "discovery:huggingface-recent",
    label: sourceLabel("discovery:huggingface-recent"),
    authority: "third_party",
    group: "Discovery",
    stream: "weights",
    intervalSeconds: 1800,
    pace: { group: "huggingface.co", seconds: 60 },
    collector: () => collectHuggingFaceDiscovery(config, fetch, cache, new Date()),
    enabled: requested("discovery:huggingface-recent"),
  });

  const shadowByDefault = new Set<string>([
    // A first sitemap observation is a quiet baseline, but a site restructure can republish
    // hundreds of paths at once. These collect evidence until their real volume is known.
    ...WATCHED_SITES.map((site) => `pages:${site.id}`),
    "github:openai/codex:pulls",
    "github:openai/codex:commits",
    ...GITHUB_DISCOVERY_QUERIES.map((query) => `discovery:github-${query.id}`),
    "discovery:huggingface-recent",
  ]);
  const resolved = definitions.map(
    (definition): SourceDefinition => ({
      ...definition,
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

/** Scheduler projection: all operational metadata still comes from buildSourceRegistry. */
export function sourceJobs(db: Database, config: AppConfig): SourceJob[] {
  return buildSourceRegistry(db, config)
    .filter((definition) => definition.enabled && sourceRequirementsReady(definition, config))
    .map((definition) => ({ ...definition, interval: definition.intervalSeconds, run: definition.collector }));
}

export function sourceRequirementsReady(definition: SourceDefinition, config: AppConfig): boolean {
  const values = config as unknown as Record<string, unknown>;
  return (definition.requiredCapabilities ?? []).every((name) => Boolean(values[name]));
}
