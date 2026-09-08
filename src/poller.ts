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
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "./sources/deprecations.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "./sources/github.js";
import { SourceHttpError } from "./sources/http.js";
import { collectAnthropicNews, collectOpenAINews } from "./sources/news.js";
import { collectPlatformStatus, PLATFORMS } from "./sources/platforms.js";
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

type SourceJob = {
  id: string;
  interval: number;
  run: () => Promise<Collection>;
  pace?: { group: string; seconds: number };
};

/**
 * Each consecutive failure doubles the wait, up to eight times the normal interval. A source that
 * is refusing us recovers on its own schedule, and asking every two minutes in the meantime is how
 * a refusal turns into a block — which is exactly what happened when a status page's bot
 * protection started answering with a CAPTCHA.
 */
export function due(checkedAt: string | null, interval: number, failures: number, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - Date.parse(checkedAt) >= interval * Math.min(2 ** failures, 8) * 1000;
}

export function sourceJobs(db: Database, config: AppConfig): SourceJob[] {
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
    // Twelve requests to one host in the same second read as a burst and earned a 429. The shared
    // pace survives restarts through each source's stored check time; differing intervals keep the
    // steady-state schedule spread out as well.
    ...HF_AUTHORS.map((author, index) => ({
      id: `huggingface:${author}`,
      interval: 1800 + index * 90,
      pace: { group: "huggingface.co", seconds: 60 },
      run: () => collectHuggingFace(author, config.HF_TOKEN, fetch, cache),
    })),
    ...MODELSCOPE_PATHS.map((path, index) => ({
      id: `modelscope:${path}`,
      interval: 1800 + index * 90,
      pace: { group: "modelscope.cn", seconds: 60 },
      run: () => collectModelScope(path),
    })),
    ...DESIGNARENA_CATEGORIES.map((category, index) => ({
      id: `designarena:${category}`,
      interval: 3600 + index * 120,
      pace: { group: "designarena.ai", seconds: 60 },
      run: () => collectDesignArena(category),
    })),
    { id: "cursor-changelog", interval: 1800, run: () => collectCursorChangelog() },
    // Retirement dates change rarely and matter for months; hourly is plenty.
    { id: "openai-deprecations", interval: 3600, run: () => collectOpenAIDeprecations() },
    { id: "anthropic-deprecations", interval: 3600, run: () => collectAnthropicDeprecations() },
    // Health is the one thing a reader may need within minutes, so it is polled far more often
    // than anything else here. The documents are small and answer in milliseconds.
    ...PLATFORMS.map((platform) => ({
      id: `status:${platform.id}`,
      interval: platform.interval,
      run: () => collectPlatformStatus(platform),
    })),
    ...NPM_PACKAGES.map((name, index) => ({
      id: `npm:${name}`,
      interval: 900 + index * 45,
      run: () => collectNpm(name, fetch, cache),
    })),
    ...PYPI_PACKAGES.map((name, index) => ({
      id: `pypi:${name}`,
      interval: 900 + index * 45,
      run: () => collectPypi(name, fetch, cache),
    })),
  ];
  if (config.OPENAI_API_KEY)
    jobs.push({ id: "openai", interval: config.pollSeconds, run: () => collectOpenAI(config) });
  if (config.ANTHROPIC_API_KEY)
    jobs.push({ id: "anthropic", interval: config.pollSeconds, run: () => collectAnthropic(config) });
  if (config.GEMINI_API_KEY)
    jobs.push({ id: "gemini", interval: config.pollSeconds, run: () => collectGemini(config) });
  for (const watch of config.github) {
    jobs.push({
      id: `github:${watch.repo}:pulls`,
      interval: 1800,
      run: () => collectGithubPulls(db, config, watch, fetch, cache),
    });
    jobs.push({
      id: `github:${watch.repo}:commits`,
      interval: 1800,
      run: () => collectGithubCommits(db, config, watch, fetch, cache),
    });
    jobs.push({
      id: `github:${watch.repo}:releases`,
      interval: 1800,
      run: () => collectGithubReleases(db, config, watch, fetch, cache),
    });
  }
  return jobs;
}
export async function pollSources(db: Database, config: AppConfig, force = false): Promise<void> {
  const jobs = sourceJobs(db, config);
  const rows = new Map(
    jobs.map((job) => [
      job.id,
      db
        .query<{ checked_at: string | null; failures: number; retry_at: string | null }, [string]>(
          "SELECT checked_at,failures,retry_at FROM sources WHERE id=?",
        )
        .get(job.id),
    ]),
  );
  const pacedAt = new Map<string, number>();
  for (const job of jobs) {
    const checkedAt = rows.get(job.id)?.checked_at;
    if (job.pace && checkedAt)
      pacedAt.set(job.pace.group, Math.max(pacedAt.get(job.pace.group) ?? 0, Date.parse(checkedAt)));
  }

  for (const job of jobs) {
    const last = rows.get(job.id);
    const now = Date.now();
    if (last?.retry_at && Date.parse(last.retry_at) > now) continue;
    if (!force && !due(last?.checked_at ?? null, job.interval, last?.failures ?? 0, now)) continue;
    if (job.pace && now - (pacedAt.get(job.pace.group) ?? 0) < job.pace.seconds * 1000) continue;
    try {
      const collection = await job.run();
      const checkedAt = new Date().toISOString();
      const events = saveCollection(
        db,
        collection,
        config.destinations,
        checkedAt,
        config.REPORT_BASE_URL,
        config.vendorRoles,
      );
      db.query("UPDATE sources SET failures=0,retry_at=NULL WHERE id=?").run(job.id);
      if (job.pace) pacedAt.set(job.pace.group, Date.parse(checkedAt));
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
      const checkedAt = new Date().toISOString();
      const retryAt = error instanceof SourceHttpError ? error.retryAt : null;
      db.query(
        `INSERT INTO sources(id,last_error,checked_at,failures,retry_at) VALUES(?,?,?,1,?)
         ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at,
           failures=MIN(sources.failures+1,6),retry_at=excluded.retry_at`,
      ).run(job.id, message, checkedAt, retryAt);
      if (job.pace) pacedAt.set(job.pace.group, Date.parse(checkedAt));
      // A failure breaks consecutive confirmation of a disappearance.
      db.query("UPDATE records SET missing_count=0 WHERE source=?").run(job.id);
      log("warn", "Source collection failed", { source: job.id, error: message });
    }
  }
}
