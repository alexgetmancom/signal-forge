export const METRIC_BUCKET_MS = 60 * 60 * 1000;
export const DURATION_BUCKET_LIMITS_MS = [
  0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;

export function bucketStart(now: number): string {
  return new Date(Math.floor(now / METRIC_BUCKET_MS) * METRIC_BUCKET_MS).toISOString();
}

export function emptyBuckets(): number[] {
  return Array.from({ length: DURATION_BUCKET_LIMITS_MS.length }, () => 0);
}
