import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { round } from "../numbers.js";

export const DEEPSEEK_SUMMARY_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_SUMMARY_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_SUMMARY_OPERATION = "summary.fillSummaries";
export const DEEPSEEK_SUMMARY_MAX_INPUT_CHARS = 6_000;
export const DEEPSEEK_SUMMARY_MAX_OUTPUT_TOKENS = 90;
export const DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT = 300;
const DEEPSEEK_PRICING_VERSION = "deepseek-flash-2026-08-16";

type DeepSeekPricingPeriod = "peak" | "off_peak";
type DeepSeekCostBasis = "exact" | "estimated" | "unknown";
type DeepSeekOutcome = "pending" | "summarized" | "unclear" | "invalid" | "rejected" | "failed" | "legacy";

export type DeepSeekTokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
};

export type DeepSeekAttemptResult = {
  outcome: Exclude<DeepSeekOutcome, "pending" | "legacy">;
  responseStatus: number | null;
  usage: DeepSeekTokenUsage | null;
  errorType: string | null;
};

export type DeepSeekCost = {
  costUsd: number | null;
  costBasis: DeepSeekCostBasis;
  pricingPeriod: DeepSeekPricingPeriod;
};

const DEEPSEEK_PRICING = {
  currency: "USD",
  unit: "per 1M tokens",
  version: DEEPSEEK_PRICING_VERSION,
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
} as const;

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
] as const;

type DeepSeekUsageContext = {
  eventId: number;
  source: string;
  stream: string;
  inputChars: number;
  attemptedAt: Date;
};

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

export function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim().replace(/\s+/g, " ").slice(0, 120);
  return "UnknownError";
}

function dateOf(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function pricingPeriod(attemptedAt: Date | string | number): DeepSeekPricingPeriod {
  const date = dateOf(attemptedAt);
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  const weekdayPeak = weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  return weekdayPeak ? "peak" : "off_peak";
}

function rates(period: DeepSeekPricingPeriod): { cacheHit: number; cacheMiss: number; output: number } {
  return period === "peak" ? DEEPSEEK_PRICING.peak : DEEPSEEK_PRICING.offPeak;
}

export function calculateDeepSeekCost(
  usage: DeepSeekTokenUsage | null,
  attemptedAt: Date | string | number,
): DeepSeekCost {
  const period = pricingPeriod(attemptedAt);
  if (!usage || usage.completionTokens === null) return { costUsd: null, costBasis: "unknown", pricingPeriod: period };
  const price = rates(period);
  if (usage.promptCacheHitTokens !== null && usage.promptCacheMissTokens !== null) {
    return {
      costUsd:
        Math.round(
          ((usage.promptCacheHitTokens * price.cacheHit +
            usage.promptCacheMissTokens * price.cacheMiss +
            usage.completionTokens * price.output) /
            1_000_000) *
            1_000_000_000_000,
        ) / 1_000_000_000_000,
      costBasis: "exact",
      pricingPeriod: period,
    };
  }
  if (usage.promptTokens !== null) {
    return {
      costUsd:
        Math.round(
          ((usage.promptTokens * price.cacheMiss + usage.completionTokens * price.output) / 1_000_000) *
            1_000_000_000_000,
        ) / 1_000_000_000_000,
      costBasis: "estimated",
      pricingPeriod: period,
    };
  }
  return { costUsd: null, costBasis: "unknown", pricingPeriod: period };
}

/** Claims one event before the network request, so concurrent workers cannot pay twice for it. */
export function claimDeepSeekUsage(db: Database, context: DeepSeekUsageContext): number | null {
  try {
    const row = db
      .query<{ id: number }, [number, string, string, string, string, string, number, number, string, string, string]>(
        `INSERT INTO deepseek_usage(
           event_id,attempted_at,operation,source,stream,model,attempts,input_chars,outcome,cost_basis,pricing_period
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        context.eventId,
        context.attemptedAt.toISOString(),
        DEEPSEEK_SUMMARY_OPERATION,
        context.source,
        context.stream,
        DEEPSEEK_SUMMARY_MODEL,
        1,
        Math.max(0, Math.round(context.inputChars)),
        "pending",
        "unknown",
        pricingPeriod(context.attemptedAt),
      );
    return row?.id ?? null;
  } catch (error) {
    log("warn", "DeepSeek usage claim could not be stored", {
      event: context.eventId,
      errorType: safeErrorType(error),
    });
    return null;
  }
}

/** Completes the claim with provider usage and a frozen price calculation. */
export function finishDeepSeekUsage(db: Database, id: number, result: DeepSeekAttemptResult): void {
  try {
    const row = db
      .query<{ attempted_at: string }, [number]>("SELECT attempted_at FROM deepseek_usage WHERE id=?")
      .get(id);
    if (!row) return;
    const cost = calculateDeepSeekCost(result.usage, row.attempted_at);
    db.query(
      `UPDATE deepseek_usage
       SET response_status=?,outcome=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,
           prompt_cache_hit_tokens=?,prompt_cache_miss_tokens=?,cost_usd=?,cost_basis=?,pricing_period=?,error_type=?
       WHERE id=?`,
    ).run(
      result.responseStatus,
      result.outcome,
      result.usage?.promptTokens ?? null,
      result.usage?.completionTokens ?? null,
      result.usage?.totalTokens ?? null,
      result.usage?.promptCacheHitTokens ?? null,
      result.usage?.promptCacheMissTokens ?? null,
      cost.costUsd,
      cost.costBasis,
      cost.pricingPeriod,
      result.errorType,
      id,
    );
  } catch (error) {
    log("warn", "DeepSeek usage result could not be stored", { usageId: id, errorType: safeErrorType(error) });
  }
}

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

export function deepSeekAttemptsToday(db: Database, now: Date): number {
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
  const end = new Date(Date.parse(start) + 24 * 3_600_000).toISOString();
  const row = db
    .query<{ attempts: number | null }, [string, string]>(
      "SELECT COALESCE(SUM(attempts),0) AS attempts FROM deepseek_usage WHERE attempted_at>=? AND attempted_at<?",
    )
    .get(start, end);
  return Math.max(0, Number(row?.attempts ?? 0));
}
