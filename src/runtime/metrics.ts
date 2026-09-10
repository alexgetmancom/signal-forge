import type { Database } from "bun:sqlite";
import { log } from "../logger.js";

const METRIC_BUCKET_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const DURATION_BUCKET_LIMITS_MS = [
  0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;

type StoredMetric = {
  name: string;
  bucket_start: string;
  calls: number;
  failures: number;
  total_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  duration_buckets_json: string;
  last_called_at: string;
  last_error_at: string | null;
  last_error_type: string | null;
};

type MetricAggregate = {
  name: string;
  calls: number;
  failures: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  durationBuckets: number[];
  lastCalledAt: string;
  lastErrorAt: string | null;
  lastErrorType: string | null;
};

export type CodeAnalyticsSection = {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  failureRate: number;
  totalDurationMs: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  lastCalledAt: string;
  lastErrorAt: string | null;
  lastErrorType: string | null;
};

export type CodeAnalyticsReport = {
  since: string;
  until: string;
  days: number;
  totals: {
    calls: number;
    successes: number;
    failures: number;
    failureRate: number;
    totalDurationMs: number;
    averageDurationMs: number;
  };
  sections: CodeAnalyticsSection[];
  timeline: {
    bucketStart: string;
    calls: number;
    failures: number;
    totalDurationMs: number;
    averageDurationMs: number;
  }[];
};

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bucketStart(now: number): string {
  return new Date(Math.floor(now / METRIC_BUCKET_MS) * METRIC_BUCKET_MS).toISOString();
}

function durationBucket(durationMs: number): number {
  const index = DURATION_BUCKET_LIMITS_MS.findIndex((limit) => durationMs <= limit);
  return index === -1 ? DURATION_BUCKET_LIMITS_MS.length - 1 : index;
}

function emptyBuckets(): number[] {
  return Array.from({ length: DURATION_BUCKET_LIMITS_MS.length }, () => 0);
}

function readBuckets(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== DURATION_BUCKET_LIMITS_MS.length) return emptyBuckets();
    return parsed.map((item) => (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : 0));
  } catch {
    return emptyBuckets();
  }
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim().slice(0, 120);
  return "UnknownError";
}

function recordFailure(db: Database, name: string, durationMs: number, error: unknown, now: number): void {
  recordCodeMetric(db, name, durationMs, true, now, errorType(error));
}

/** Stores one bounded, hourly execution sample. Telemetry failures never affect application work. */
export function recordCodeMetric(
  db: Database,
  name: string,
  durationMs: number,
  failed: boolean,
  now = Date.now(),
  lastErrorType: string | null = null,
): void {
  const calledAt = new Date(now).toISOString();
  const bucket = bucketStart(now);
  const duration = Math.max(0, Math.round(durationMs));
  try {
    const existing = db
      .query<StoredMetric, [string, string]>(
        `SELECT name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
                duration_buckets_json,last_called_at,last_error_at,last_error_type
         FROM code_metrics WHERE name=? AND bucket_start=?`,
      )
      .get(name, bucket);
    const buckets = existing ? readBuckets(existing.duration_buckets_json) : emptyBuckets();
    const index = durationBucket(duration);
    buckets[index] = (buckets[index] ?? 0) + 1;
    if (existing) {
      db.query(
        `UPDATE code_metrics
         SET calls=calls+1,
             failures=failures+?,
             total_duration_ms=total_duration_ms+?,
             min_duration_ms=MIN(min_duration_ms,?),
             max_duration_ms=MAX(max_duration_ms,?),
             duration_buckets_json=?,
             last_called_at=?,
             last_error_at=CASE WHEN ? THEN ? ELSE last_error_at END,
             last_error_type=CASE WHEN ? THEN ? ELSE last_error_type END
         WHERE name=? AND bucket_start=?`,
      ).run(
        failed ? 1 : 0,
        duration,
        duration,
        duration,
        JSON.stringify(buckets),
        calledAt,
        failed ? 1 : 0,
        calledAt,
        failed ? 1 : 0,
        lastErrorType,
        name,
        bucket,
      );
    } else {
      db.query(
        `INSERT INTO code_metrics(
           name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
           duration_buckets_json,last_called_at,last_error_at,last_error_type
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        name,
        bucket,
        1,
        failed ? 1 : 0,
        duration,
        duration,
        duration,
        JSON.stringify(buckets),
        calledAt,
        failed ? calledAt : null,
        failed ? lastErrorType : null,
      );
    }
  } catch {
    log("warn", "Code metric could not be stored", { metric: name });
  }
}

export function measure<T>(db: Database, name: string, operation: () => T): T;
export function measure<T>(db: Database, name: string, operation: () => Promise<T>): Promise<T>;
export function measure<T>(db: Database, name: string, operation: () => T | Promise<T>): T | Promise<T> {
  const started = Date.now();
  try {
    const result = operation();
    if (result instanceof Promise)
      return result.then(
        (value) => {
          recordCodeMetric(db, name, Date.now() - started, false);
          return value;
        },
        (error: unknown) => {
          recordFailure(db, name, Date.now() - started, error, Date.now());
          throw error;
        },
      );
    recordCodeMetric(db, name, Date.now() - started, false);
    return result;
  } catch (error) {
    recordFailure(db, name, Date.now() - started, error, Date.now());
    throw error;
  }
}

function aggregateRows(rows: StoredMetric[]): Map<string, MetricAggregate> {
  const result = new Map<string, MetricAggregate>();
  for (const row of rows) {
    const current =
      result.get(row.name) ??
      ({
        name: row.name,
        calls: 0,
        failures: 0,
        totalDurationMs: 0,
        minDurationMs: Number.POSITIVE_INFINITY,
        maxDurationMs: 0,
        durationBuckets: emptyBuckets(),
        lastCalledAt: row.last_called_at,
        lastErrorAt: null,
        lastErrorType: null,
      } satisfies MetricAggregate);
    current.calls += row.calls;
    current.failures += row.failures;
    current.totalDurationMs += row.total_duration_ms;
    current.minDurationMs = Math.min(current.minDurationMs, row.min_duration_ms);
    current.maxDurationMs = Math.max(current.maxDurationMs, row.max_duration_ms);
    const rowBuckets = readBuckets(row.duration_buckets_json);
    current.durationBuckets = current.durationBuckets.map((count, index) => count + (rowBuckets[index] ?? 0));
    if (row.last_called_at > current.lastCalledAt) current.lastCalledAt = row.last_called_at;
    if (row.last_error_at && (!current.lastErrorAt || row.last_error_at > current.lastErrorAt)) {
      current.lastErrorAt = row.last_error_at;
      current.lastErrorType = row.last_error_type;
    }
    result.set(row.name, current);
  }
  return result;
}

function percentile(buckets: number[], percentileValue: number): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  const target = Math.max(1, Math.ceil(total * percentileValue));
  let seen = 0;
  for (let index = 0; index < buckets.length; index++) {
    seen += buckets[index] ?? 0;
    if (seen >= target) return DURATION_BUCKET_LIMITS_MS[index] ?? 0;
  }
  return DURATION_BUCKET_LIMITS_MS[DURATION_BUCKET_LIMITS_MS.length - 1] ?? 0;
}

function sectionReport(metric: MetricAggregate): CodeAnalyticsSection {
  return {
    name: metric.name,
    calls: metric.calls,
    successes: metric.calls - metric.failures,
    failures: metric.failures,
    failureRate: metric.calls ? round(metric.failures / metric.calls, 4) : 0,
    totalDurationMs: metric.totalDurationMs,
    averageDurationMs: metric.calls ? round(metric.totalDurationMs / metric.calls) : 0,
    minDurationMs: Number.isFinite(metric.minDurationMs) ? metric.minDurationMs : 0,
    maxDurationMs: metric.maxDurationMs,
    p50DurationMs: percentile(metric.durationBuckets, 0.5),
    p95DurationMs: percentile(metric.durationBuckets, 0.95),
    lastCalledAt: metric.lastCalledAt,
    lastErrorAt: metric.lastErrorAt,
    lastErrorType: metric.lastErrorType,
  };
}

export function codeAnalytics(db: Database, days = 7, now = Date.now()): CodeAnalyticsReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Code analytics days must be between 1 and 90");
  const until = new Date(now).toISOString();
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const firstBucket = bucketStart(now - days * 24 * 3_600_000);
  const rows = db
    .query<StoredMetric, [string, string]>(
      `SELECT name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
              duration_buckets_json,last_called_at,last_error_at,last_error_type
       FROM code_metrics WHERE bucket_start>=? AND bucket_start<=? ORDER BY bucket_start,name`,
    )
    .all(firstBucket, until);
  const metrics = [...aggregateRows(rows).values()].sort((left, right) => {
    if (right.totalDurationMs !== left.totalDurationMs) return right.totalDurationMs - left.totalDurationMs;
    return left.name.localeCompare(right.name);
  });
  const calls = metrics.reduce((sum, metric) => sum + metric.calls, 0);
  const failures = metrics.reduce((sum, metric) => sum + metric.failures, 0);
  const totalDurationMs = metrics.reduce((sum, metric) => sum + metric.totalDurationMs, 0);
  const timeline = new Map<string, { calls: number; failures: number; totalDurationMs: number }>();
  for (const row of rows) {
    const current = timeline.get(row.bucket_start) ?? { calls: 0, failures: 0, totalDurationMs: 0 };
    current.calls += row.calls;
    current.failures += row.failures;
    current.totalDurationMs += row.total_duration_ms;
    timeline.set(row.bucket_start, current);
  }
  return {
    since,
    until,
    days,
    totals: {
      calls,
      successes: calls - failures,
      failures,
      failureRate: calls ? round(failures / calls, 4) : 0,
      totalDurationMs,
      averageDurationMs: calls ? round(totalDurationMs / calls) : 0,
    },
    sections: metrics.map(sectionReport),
    timeline: [...timeline.entries()].map(([bucketStartValue, value]) => ({
      bucketStart: bucketStartValue,
      ...value,
      averageDurationMs: value.calls ? round(value.totalDurationMs / value.calls) : 0,
    })),
  };
}

export function pruneCodeMetrics(db: Database, now = Date.now()): void {
  const before = new Date(now - RETENTION_DAYS * 24 * 3_600_000).toISOString();
  try {
    db.query("DELETE FROM code_metrics WHERE bucket_start<?").run(before);
  } catch {
    log("warn", "Code metric retention cleanup failed");
  }
}
