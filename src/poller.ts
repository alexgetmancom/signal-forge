import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import type { Collection } from "./events.js";
import { saveCollection } from "./events.js";
import { log } from "./logger.js";
import { collectArena, collectLeaderboards } from "./sources/arena.js";
import { collectAnthropic, collectGemini, collectOpenAI, collectOpenRouter } from "./sources/catalogs.js";
import { collectClaude } from "./sources/claude.js";
import { collectCodexDocs } from "./sources/codex.js";
import {
  collectCursorChangelog,
  collectDesignArena,
  collectModelScope,
  DESIGNARENA_CATEGORIES,
  MODELSCOPE_PATHS,
} from "./sources/community.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "./sources/github.js";
import { collectAnthropicNews, collectOpenAINews } from "./sources/news.js";
import {
  collectHuggingFace,
  collectNpm,
  collectPypi,
  collectVercelGateway,
  HF_AUTHORS,
  NPM_PACKAGES,
  PYPI_PACKAGES,
} from "./sources/registries.js";
import { HttpCache } from "./storage/httpCache.js";

export function sourceJobs(
  db: Database,
  config: AppConfig,
): { id: string; interval: number; run: () => Promise<Collection> }[] {
  const cache = new HttpCache(db);
  const jobs = [
    { id: "openrouter", interval: config.pollSeconds, run: () => collectOpenRouter() },
    { id: "openai-news", interval: 900, run: () => collectOpenAINews() },
    { id: "anthropic-news", interval: 900, run: () => collectAnthropicNews() },
    { id: "vercel-gateway", interval: config.pollSeconds, run: () => collectVercelGateway() },
    { id: "arena", interval: config.pollSeconds, run: () => collectArena() },
    { id: "arena-leaderboards", interval: 1800, run: () => collectLeaderboards() },
    // Documentation and the interface are watched often on purpose: a page appearing there is the
    // earliest public sign of a feature. The cache is what makes "often" cheap.
    { id: "codex-docs", interval: 3600, run: () => collectCodexDocs(fetch, cache) },
    { id: "claude-web", interval: 3600, run: () => collectClaude(fetch, cache) },
    // Registries move slowly and are many, so they are polled far apart and spread over the hour
    // rather than hammered together every cycle.
    ...HF_AUTHORS.map((author) => ({
      id: `huggingface:${author}`,
      interval: 1800,
      run: () => collectHuggingFace(author, fetch, cache),
    })),
    ...MODELSCOPE_PATHS.map((path) => ({
      id: `modelscope:${path}`,
      interval: 1800,
      run: () => collectModelScope(path),
    })),
    ...DESIGNARENA_CATEGORIES.map((category) => ({
      id: `designarena:${category}`,
      interval: 3600,
      run: () => collectDesignArena(category),
    })),
    { id: "cursor-changelog", interval: 1800, run: () => collectCursorChangelog() },
    ...NPM_PACKAGES.map((name) => ({ id: `npm:${name}`, interval: 900, run: () => collectNpm(name, fetch, cache) })),
    ...PYPI_PACKAGES.map((name) => ({ id: `pypi:${name}`, interval: 900, run: () => collectPypi(name, fetch, cache) })),
  ];
  if (config.OPENAI_API_KEY)
    jobs.push({ id: "openai", interval: config.pollSeconds, run: () => collectOpenAI(config) });
  if (config.ANTHROPIC_API_KEY)
    jobs.push({ id: "anthropic", interval: config.pollSeconds, run: () => collectAnthropic(config) });
  if (config.GEMINI_API_KEY)
    jobs.push({ id: "gemini", interval: config.pollSeconds, run: () => collectGemini(config) });
  for (const watch of config.github) {
    jobs.push({ id: `github:${watch.repo}:pulls`, interval: 1800, run: () => collectGithubPulls(db, config, watch) });
    jobs.push({
      id: `github:${watch.repo}:commits`,
      interval: 1800,
      run: () => collectGithubCommits(db, config, watch),
    });
    jobs.push({
      id: `github:${watch.repo}:releases`,
      interval: 1800,
      run: () => collectGithubReleases(db, config, watch),
    });
  }
  return jobs;
}
export async function pollSources(db: Database, config: AppConfig, force = false): Promise<void> {
  for (const job of sourceJobs(db, config)) {
    const last = db
      .query<{ checked_at: string | null }, [string]>("SELECT checked_at FROM sources WHERE id=?")
      .get(job.id);
    if (!force && last?.checked_at && Date.now() - Date.parse(last.checked_at) < job.interval * 1000) continue;
    try {
      const collection = await job.run();
      const events = saveCollection(
        db,
        collection,
        config.destinations,
        new Date().toISOString(),
        config.REPORT_BASE_URL,
        config.vendorRoles,
      );
      log("info", "Source collected", { source: job.id, records: collection.records.length, events });
    } catch (error) {
      // Source errors may contain credentials or an entire invalid response. Keep a safe operational category.
      const message =
        error instanceof Error &&
        /^(Source |Public page |GitHub |Anthropic |Gemini |Invalid RSS|.*: empty collection|.*: duplicate record)/.test(
          error.message,
        )
          ? error.message
          : "Collection failed: network or schema validation error";
      db.query(
        "INSERT INTO sources(id,last_error,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at",
      ).run(job.id, message, new Date().toISOString());
      // A failure breaks consecutive confirmation of a disappearance.
      db.query("UPDATE records SET missing_count=0 WHERE source=?").run(job.id);
      log("warn", "Source collection failed", { source: job.id, error: message });
    }
  }
}
