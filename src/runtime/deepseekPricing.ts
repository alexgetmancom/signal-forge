const DEEPSEEK_PRICING_VERSION = "deepseek-flash-2026-08-16";

export type DeepSeekPricingPeriod = "peak" | "off_peak";
export type DeepSeekCostBasis = "exact" | "estimated" | "unknown";
export type DeepSeekTokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
};

export type DeepSeekCost = {
  costUsd: number | null;
  costBasis: DeepSeekCostBasis;
  pricingPeriod: DeepSeekPricingPeriod;
};

export const DEEPSEEK_PRICING = {
  currency: "USD",
  unit: "per 1M tokens",
  version: DEEPSEEK_PRICING_VERSION,
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
} as const;

function dateOf(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function pricingPeriod(attemptedAt: Date | string | number): DeepSeekPricingPeriod {
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
