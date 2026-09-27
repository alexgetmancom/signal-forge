import type { Database } from "bun:sqlite";
import { round } from "../numbers.js";
import {
  DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT,
  DEEPSEEK_SUMMARY_MAX_INPUT_CHARS,
  DEEPSEEK_SUMMARY_MAX_OUTPUT_TOKENS,
  DEEPSEEK_SUMMARY_MODEL,
  DEEPSEEK_SUMMARY_OPERATION,
  type DeepSeekOutcome,
  judgeRun,
} from "../runtime/deepseekLedger.js";
import { DEEPSEEK_PRICING, type DeepSeekCostBasis, type DeepSeekPricingPeriod } from "../runtime/deepseekPricing.js";

const DEEPSEEK_CODE_PATHS = [
  {
    operation: DEEPSEEK_SUMMARY_OPERATION,
    path: "src/summary.ts",
    function: "fillSummaries",
    purpose: "Adds one factual sentence before long notification-bearing diffs are delivered.",
    trigger: "Large, notification-bearing events in an unsealed delivery batch whose ready time has arrived.",
    optimization:
      "One attempt per event, a 6,000-character input cap, a 90-token output cap and a 300-attempt daily ceiling.",
  },
  {
    operation: "mentions.judge",
    path: "src/sources/mentionStage.ts",
    function: "judgeMentions",
    purpose: "Says whether a model ID in a commit or a user's post was written down, served to someone, or is noise.",
    trigger: "A commit or issue naming a model that no catalogue lists and no watched repository has told.",
    optimization:
      "Only unlisted IDs newer than every listed version are judged; a 4,000-character input cap and one call per post.",
  },
  {
    operation: "audience.judge",
    path: "src/sources/audienceJudge.ts",
    function: "judgeAudience",
    purpose: "Says whether a ChatGPT release note is for builders (models, API, Codex, agents) or for consumers.",
    trigger: "A ChatGPT release-notes entry the database has not stored before.",
    optimization: "Only new entries, all of one poll in one call, 400 characters of each, a 2,000-token output cap.",
  },
] as const;

type StoredDeepSeekUsage = {
  id: number;
  attempted_at: string;
  operation: string;
  event_id: number | null;
  source: string | null;
  stream: string | null;
  model: string;
  attempts: number;
  input_chars: number;
  response_status: number | null;
  outcome: DeepSeekOutcome;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cache_hit_tokens: number | null;
  prompt_cache_miss_tokens: number | null;
  cost_usd: number | null;
  cost_basis: DeepSeekCostBasis;
  pricing_period: DeepSeekPricingPeriod | null;
  error_type: string | null;
};

type UsageTotals = {
  attempts: number;
  events: number;
  summarized: number;
  unclear: number;
  invalid: number;
  rejected: number;
  failed: number;
  pending: number;
  legacy: number;
  inputChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  pricedAttempts: number;
  unpricedAttempts: number;
  exactCostUsd: number;
  estimatedCostUsd: number;
  totalCostUsd: number;
};

type DeepSeekUsageStats = {
  attempts: number;
  events: number;
  outcomes: {
    summarized: number;
    unclear: number;
    invalid: number;
    rejected: number;
    failed: number;
    pending: number;
    legacy: number;
  };
  inputChars: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    cacheHit: number;
    cacheMiss: number;
  };
  cost: {
    currency: "USD";
    exactUsd: number;
    estimatedUsd: number;
    totalUsd: number;
    totalCents: number;
    pricedAttempts: number;
    unpricedAttempts: number;
    coverage: number;
  };
};

export type DeepSeekUsageReport = {
  provider: "DeepSeek";
  model: string;
  purpose: string;
  scope: string;
  since: string;
  until: string;
  days: number;
  limits: {
    dailyAttempts: number;
    maxInputChars: number;
    maxOutputTokens: number;
  };
  pricing: typeof DEEPSEEK_PRICING;
  codePaths: typeof DEEPSEEK_CODE_PATHS;
  totals: DeepSeekUsageStats;
  byOperation: { operation: string; stats: DeepSeekUsageStats }[];
  bySource: { source: string; stream: string; stats: DeepSeekUsageStats }[];
  daily: { date: string; stats: DeepSeekUsageStats }[];
};

function emptyTotals(): UsageTotals {
  return {
    attempts: 0,
    events: 0,
    summarized: 0,
    unclear: 0,
    invalid: 0,
    rejected: 0,
    failed: 0,
    pending: 0,
    legacy: 0,
    inputChars: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    pricedAttempts: 0,
    unpricedAttempts: 0,
    exactCostUsd: 0,
    estimatedCostUsd: 0,
    totalCostUsd: 0,
  };
}

function addRow(totals: UsageTotals, row: StoredDeepSeekUsage): void {
  const attempts = Math.max(0, Number(row.attempts));
  totals.attempts += attempts;
  if (row.event_id !== null) totals.events++;
  if (row.outcome === "summarized") totals.summarized += attempts;
  else if (row.outcome === "unclear") totals.unclear += attempts;
  else if (row.outcome === "invalid") totals.invalid += attempts;
  else if (row.outcome === "rejected") totals.rejected += attempts;
  else if (row.outcome === "failed") totals.failed += attempts;
  else if (row.outcome === "pending") totals.pending += attempts;
  else if (row.outcome === "legacy") totals.legacy += attempts;
  totals.inputChars += Math.max(0, Number(row.input_chars));
  totals.promptTokens += Math.max(0, row.prompt_tokens ?? 0);
  totals.completionTokens += Math.max(0, row.completion_tokens ?? 0);
  totals.totalTokens += Math.max(0, row.total_tokens ?? 0);
  totals.cacheHitTokens += Math.max(0, row.prompt_cache_hit_tokens ?? 0);
  totals.cacheMissTokens += Math.max(0, row.prompt_cache_miss_tokens ?? 0);
  if (row.cost_usd === null) totals.unpricedAttempts += attempts;
  else {
    const cost = row.cost_usd * attempts;
    totals.pricedAttempts += attempts;
    totals.totalCostUsd += cost;
    if (row.cost_basis === "exact") totals.exactCostUsd += cost;
    if (row.cost_basis === "estimated") totals.estimatedCostUsd += cost;
  }
}

function stats(totals: UsageTotals): DeepSeekUsageStats {
  return {
    attempts: totals.attempts,
    events: totals.events,
    outcomes: {
      summarized: totals.summarized,
      unclear: totals.unclear,
      invalid: totals.invalid,
      rejected: totals.rejected,
      failed: totals.failed,
      pending: totals.pending,
      legacy: totals.legacy,
    },
    inputChars: totals.inputChars,
    tokens: {
      prompt: totals.promptTokens,
      completion: totals.completionTokens,
      total: totals.totalTokens,
      cacheHit: totals.cacheHitTokens,
      cacheMiss: totals.cacheMissTokens,
    },
    cost: {
      currency: "USD",
      exactUsd: round(totals.exactCostUsd, 8),
      estimatedUsd: round(totals.estimatedCostUsd, 8),
      totalUsd: round(totals.totalCostUsd, 8),
      totalCents: round(totals.totalCostUsd * 100, 6),
      pricedAttempts: totals.pricedAttempts,
      unpricedAttempts: totals.unpricedAttempts,
      coverage: totals.attempts ? round(totals.pricedAttempts / totals.attempts, 4) : 0,
    },
  };
}

function usageRows(db: Database, since: string, until: string): StoredDeepSeekUsage[] {
  return db
    .query<StoredDeepSeekUsage, [string, string]>(
      `SELECT id,attempted_at,operation,event_id,source,stream,model,attempts,input_chars,response_status,
              outcome,prompt_tokens,completion_tokens,total_tokens,prompt_cache_hit_tokens,prompt_cache_miss_tokens,
              cost_usd,cost_basis,pricing_period,error_type
       FROM deepseek_usage
       WHERE attempted_at>=? AND attempted_at<=?
       ORDER BY attempted_at,id`,
    )
    .all(since, until);
}

function groupedStats(
  rows: StoredDeepSeekUsage[],
  key: (row: StoredDeepSeekUsage) => string,
): { key: string; stats: DeepSeekUsageStats }[] {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const group = groups.get(key(row)) ?? emptyTotals();
    addRow(group, row);
    groups.set(key(row), group);
  }
  return [...groups.entries()].map(([group, totals]) => ({ key: group, stats: stats(totals) }));
}

export function deepSeekUsage(db: Database, days = 7, now = Date.now()): DeepSeekUsageReport {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error("DeepSeek usage days must be between 1 and 365");
  const until = new Date(now).toISOString();
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const rows = usageRows(db, since, until);
  const total = emptyTotals();
  for (const row of rows) addRow(total, row);
  const operations = groupedStats(rows, (row) => row.operation).map(({ key, stats: rowStats }) => ({
    operation: key,
    stats: rowStats,
  }));
  const sources = groupedStats(rows, (row) => `${row.source ?? "legacy"}\u0000${row.stream ?? "unknown"}`).map(
    ({ key, stats: rowStats }) => {
      const [source, stream] = key.split("\u0000");
      return { source: source ?? "legacy", stream: stream ?? "unknown", stats: rowStats };
    },
  );
  const daily = groupedStats(rows, (row) => row.attempted_at.slice(0, 10)).map(({ key, stats: rowStats }) => ({
    date: key,
    stats: rowStats,
  }));
  return {
    provider: "DeepSeek",
    model: DEEPSEEK_SUMMARY_MODEL,
    purpose: "Optional one-sentence summaries for large, notification-bearing diffs.",
    scope:
      "Calls made by Signal Forge through the Summary integration; other users of the same API key are not visible here.",
    since,
    until,
    days,
    limits: {
      dailyAttempts: DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT,
      maxInputChars: DEEPSEEK_SUMMARY_MAX_INPUT_CHARS,
      maxOutputTokens: DEEPSEEK_SUMMARY_MAX_OUTPUT_TOKENS,
    },
    pricing: DEEPSEEK_PRICING,
    codePaths: DEEPSEEK_CODE_PATHS,
    totals: stats(total),
    byOperation: operations,
    bySource: sources,
    daily,
  };
}

/**
 * Every judge currently in a run of unusable answers, for the issues report.
 *
 * A judge is any operation in this ledger that answers no event: `event_id IS NULL` is what tells
 * it apart from a summary, whose attempts are already bounded per event. Only a run that has
 * reached the caller's hold-off is worth a row -- one bad answer is a bad minute.
 */
export function unusableJudgeRuns(
  db: Database,
  now = Date.now(),
  minimumAttempts = 3,
): {
  operation: string;
  source: string;
  attempts: number;
  since: string;
  lastAttemptedAt: string;
  costUsd: number | null;
  errorType: string | null;
}[] {
  const pairs = db
    .query<{ operation: string; source: string }, []>(
      `SELECT DISTINCT operation,source FROM deepseek_usage WHERE event_id IS NULL AND source IS NOT NULL`,
    )
    .all();
  const runs = [];
  for (const pair of pairs) {
    const run = judgeRun(db, pair.operation, pair.source, 200);
    if (run.length < minimumAttempts) continue;
    const oldest = run[run.length - 1];
    const newest = run[0];
    const cost = run.reduce((total, row) => total + (row.cost_usd ?? 0), 0);
    runs.push({
      operation: pair.operation,
      source: pair.source,
      attempts: run.length,
      since: oldest?.attempted_at ?? new Date(now).toISOString(),
      lastAttemptedAt: newest?.attempted_at ?? new Date(now).toISOString(),
      costUsd: cost > 0 ? cost : null,
      errorType: newest?.error_type ?? null,
    });
  }
  return runs.sort((left, right) => right.attempts - left.attempts);
}
