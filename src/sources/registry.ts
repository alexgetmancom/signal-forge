import type { Database } from "bun:sqlite";
import type { AppConfig, Stream } from "../config.js";
import type { Collection } from "../events/types.js";
import { HttpCache } from "../storage/httpCache.js";
import { collectArena, collectLeaderboards } from "./arena.js";
import { collectAnthropic, collectGemini, collectOpenAI, collectOpenRouter } from "./catalogs.js";
import { collectClaude } from "./claude.js";
import { collectCodexDocs } from "./codex.js";
import {
  collectCursorChangelog,
  collectDesignArena,
  collectModelScope,
  DESIGNARENA_CATEGORIES,
  MODELSCOPE_PATHS,
} from "./community.js";
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "./deprecations.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "./github.js";
import { sourceLabel } from "./labels.js";
import { collectAnthropicNews, collectOpenAINews } from "./news.js";
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

export type SourceDefinition = {
  id: string;
  label: string;
  vendor?: string;
  group: string;
  stream: Stream;
  intervalSeconds: number;
  requiredCapabilities?: readonly string[];
  pace?: { group: string; seconds: number };
  collector: () => Promise<Collection>;
  enabled: boolean;
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
  const definitions: SourceDefinition[] = [
    {
      id: "openrouter",
      label: sourceLabel("openrouter"),
      group: "Catalogues",
      stream: "openrouter",
      intervalSeconds: config.pollSeconds,
      collector: () => collectOpenRouter(),
      enabled: true,
    },
    {
      id: "openai-news",
      label: sourceLabel("openai-news"),
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAINews(),
      enabled: true,
    },
    {
      id: "anthropic-news",
      label: sourceLabel("anthropic-news"),
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectAnthropicNews(),
      enabled: true,
    },
    {
      id: "vercel-gateway",
      label: sourceLabel("vercel-gateway"),
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      collector: () => collectVercelGateway(),
      enabled: true,
      restrictedReason: "upstream response arrives incomplete — waiting on a full feed",
    },
    {
      id: "arena",
      label: sourceLabel("arena"),
      group: "Arena",
      stream: "arena",
      intervalSeconds: config.pollSeconds,
      collector: () => collectArena(),
      enabled: true,
    },
    {
      id: "arena-leaderboards",
      label: sourceLabel("arena-leaderboards"),
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 1800,
      collector: () => collectLeaderboards(),
      enabled: true,
    },
    {
      id: "codex-docs",
      label: sourceLabel("codex-docs"),
      vendor: "OpenAI",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCodexDocs(fetch, cache),
      enabled: true,
    },
    {
      id: "claude-web",
      label: sourceLabel("claude-web"),
      vendor: "Anthropic",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectClaude(fetch, cache),
      enabled: true,
    },
    ...HF_AUTHORS.map(
      (author, index): SourceDefinition => ({
        id: `huggingface:${author}`,
        label: sourceLabel(`huggingface:${author}`),
        group: "Open weights",
        stream: "weights",
        intervalSeconds: 1800 + index * 90,
        pace: { group: "huggingface.co", seconds: 60 },
        collector: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
        enabled: true,
      }),
    ),
    ...MODELSCOPE_PATHS.map(
      (path, index): SourceDefinition => ({
        id: `modelscope:${path}`,
        label: sourceLabel(`modelscope:${path}`),
        group: "Open weights",
        stream: "weights",
        intervalSeconds: 1800 + index * 90,
        pace: { group: "modelscope.cn", seconds: 60 },
        collector: () => collectModelScope(path),
        enabled: true,
      }),
    ),
    ...DESIGNARENA_CATEGORIES.map(
      (category, index): SourceDefinition => ({
        id: `designarena:${category}`,
        label: sourceLabel(`designarena:${category}`),
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
        enabled: true,
      }),
    ),
    {
      id: "cursor-changelog",
      label: sourceLabel("cursor-changelog"),
      vendor: "Cursor",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectCursorChangelog(),
      enabled: true,
    },
    {
      id: "openai-deprecations",
      label: sourceLabel("openai-deprecations"),
      vendor: "OpenAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectOpenAIDeprecations(),
      enabled: true,
    },
    {
      id: "anthropic-deprecations",
      label: sourceLabel("anthropic-deprecations"),
      vendor: "Anthropic",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAnthropicDeprecations(),
      enabled: true,
    },
    ...PLATFORMS.map(
      (platform): SourceDefinition => ({
        id: `status:${platform.id}`,
        label: sourceLabel(`status:${platform.id}`),
        vendor: platform.name,
        group: "Platform health",
        stream: "incidents",
        intervalSeconds: platform.interval,
        collector: () => collectPlatformStatus(platform),
        enabled: true,
      }),
    ),
    ...NPM_PACKAGES.map(
      (name, index): SourceDefinition => ({
        id: `npm:${name}`,
        label: sourceLabel(`npm:${name}`),
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        collector: () => collectNpm(name, fetch, cache),
        enabled: true,
      }),
    ),
    ...PYPI_PACKAGES.map(
      (name, index): SourceDefinition => ({
        id: `pypi:${name}`,
        label: sourceLabel(`pypi:${name}`),
        group: "Packages",
        stream: "packages",
        intervalSeconds: 900 + index * 45,
        collector: () => collectPypi(name, fetch, cache),
        enabled: true,
      }),
    ),
    {
      id: "openai",
      label: sourceLabel("openai"),
      vendor: "OpenAI",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      requiredCapabilities: ["OPENAI_API_KEY"],
      collector: () => collectOpenAI(config),
      enabled: Boolean(config.OPENAI_API_KEY),
    },
    {
      id: "anthropic",
      label: sourceLabel("anthropic"),
      vendor: "Anthropic",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      requiredCapabilities: ["ANTHROPIC_API_KEY"],
      collector: () => collectAnthropic(config),
      enabled: Boolean(config.ANTHROPIC_API_KEY),
    },
    {
      id: "gemini",
      label: sourceLabel("gemini"),
      vendor: "Google",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: config.pollSeconds,
      requiredCapabilities: ["GEMINI_API_KEY"],
      collector: () => collectGemini(config),
      enabled: Boolean(config.GEMINI_API_KEY),
      restrictedReason: "upstream is not serving this feed to us — no data reaching the collector",
    },
  ];

  for (const watch of config.github) {
    definitions.push(
      {
        id: `github:${watch.repo}:pulls`,
        label: sourceLabel(`github:${watch.repo}:pulls`),
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubPulls(db, config, watch, fetch, cache),
        enabled: true,
      },
      {
        id: `github:${watch.repo}:commits`,
        label: sourceLabel(`github:${watch.repo}:commits`),
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubCommits(db, config, watch, fetch, cache),
        enabled: true,
      },
      {
        id: `github:${watch.repo}:releases`,
        label: sourceLabel(`github:${watch.repo}:releases`),
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
        enabled: true,
      },
    );
  }

  validateSourceRegistry(definitions);
  return definitions;
}

export function validateSourceRegistry(definitions: readonly SourceDefinition[]): void {
  const ids = new Set<string>();
  const pacing = new Map<string, number>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate source ID: ${definition.id}`);
    ids.add(definition.id);
    if (!definition.label.trim()) throw new Error(`Source ${definition.id} has no label`);
    if (!definition.group.trim()) throw new Error(`Source ${definition.id} has no group`);
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
    .filter((definition) => definition.enabled)
    .map((definition) => ({ ...definition, interval: definition.intervalSeconds, run: definition.collector }));
}
