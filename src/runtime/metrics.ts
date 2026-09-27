import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { round } from "../numbers.js";
import { readRuntime } from "./observability.js";
import { peakGrowthKb, peakKb } from "./peak.js";

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
  peak_growth_kb: number;
  max_peak_growth_kb: number;
  last_called_at: string;
  last_error_at: string | null;
  last_error_type: string | null;
};

/**
 * One section's numbers as SQL adds them up: a row per name, not a row per name and hour.
 *
 * Named after the columns rather than after the table, because nothing here is a stored row any
 * more -- `minDurationMs` is the smallest of the window and `lastErrorType` the newest failure in
 * it, neither of which any single row holds.
 */
type SectionTotals = {
  name: string;
  calls: number;
  failures: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  /** What this section added to the process's peak across the window, summed over its calls. */
  peakGrowthKb: number;
  /** The worst single call's growth, which is the number a memory limit is sized from. */
  maxPeakGrowthKb: number;
  lastCalledAt: string;
  lastErrorAt: string | null;
  lastErrorType: string | null;
};

type CodeAnalyticsSection = {
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
  /**
   * What this section added to the floor: the sum across the window, and the worst single call.
   *
   * RSS is a high-water mark the allocator never returns, so a section that claimed 200 MB once is
   * why this service is sized for it forever after. `peakGrowthMb` is what an hour of this section
   * costs and `maxPeakGrowthMb` is what one call can do; a section that shows 0 in both has either
   * not run since the deploy that started recording this, or genuinely holds nothing new.
   */
  peakGrowthMb: number;
  maxPeakGrowthMb: number;
  lastCalledAt: string;
  lastErrorAt: string | null;
  lastErrorType: string | null;
};

export type CodeAnalyticsReport = {
  since: string;
  until: string;
  days: number;
  /**
   * The hour the window opens in, when the moment asked for falls inside one rather than on its
   * edge. That hour holds both sides of the boundary and is left out: a deploy at 13:34 cannot be
   * measured from a bucket that also holds 13:00 to 13:34, and a report that quietly included it
   * would say the new build was slow because the old one was.
   */
  straddled: string | null;
  totals: {
    calls: number;
    successes: number;
    failures: number;
    failureRate: number;
    totalDurationMs: number;
    averageDurationMs: number;
    /** The floor the answered sections raised between them, which no single one of them explains. */
    peakGrowthMb: number;
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

function recordFailure(
  db: Database,
  name: string,
  durationMs: number,
  error: unknown,
  now: number,
  peakGrowth: number,
): void {
  recordCodeMetric(db, name, durationMs, true, now, errorType(error), peakGrowth);
}

/**
 * One call as both statements below take it: the row's two keys and the four things a call carries.
 *
 * A record rather than eleven positional arguments twice over, because the update and the insert
 * bind the same values in different orders, and the fifth `duration` in a row of them is where a
 * duration ends up in the column for a growth.
 */
type CallSample = {
  name: string;
  bucket: string;
  calledAt: string;
  duration: number;
  /** Kilobytes this call added to the process's peak; see `measure`. */
  growth: number;
  failed: boolean;
  lastErrorType: string | null;
};

/** Folds one call into the bucket that already exists. `MIN`/`MAX` keep the extremes of the hour. */
function extendBucket(db: Database, sample: CallSample, buckets: readonly number[]): void {
  db.query(
    `UPDATE code_metrics
     SET calls=calls+1,
         failures=failures+?,
         total_duration_ms=total_duration_ms+?,
         min_duration_ms=MIN(min_duration_ms,?),
         max_duration_ms=MAX(max_duration_ms,?),
         duration_buckets_json=?,
         peak_growth_kb=peak_growth_kb+?,
         max_peak_growth_kb=MAX(max_peak_growth_kb,?),
         last_called_at=?,
         last_error_at=CASE WHEN ? THEN ? ELSE last_error_at END,
         last_error_type=CASE WHEN ? THEN ? ELSE last_error_type END
     WHERE name=? AND bucket_start=?`,
  ).run(
    sample.failed ? 1 : 0,
    sample.duration,
    sample.duration,
    sample.duration,
    JSON.stringify(buckets),
    sample.growth,
    sample.growth,
    sample.calledAt,
    sample.failed ? 1 : 0,
    sample.calledAt,
    sample.failed ? 1 : 0,
    sample.lastErrorType,
    sample.name,
    sample.bucket,
  );
}

/** The first call of an hour, which is the same numbers with this call as all of them. */
function openBucket(db: Database, sample: CallSample, buckets: readonly number[]): void {
  db.query(
    `INSERT INTO code_metrics(
       name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
       duration_buckets_json,peak_growth_kb,max_peak_growth_kb,last_called_at,last_error_at,last_error_type
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    sample.name,
    sample.bucket,
    1,
    sample.failed ? 1 : 0,
    sample.duration,
    sample.duration,
    sample.duration,
    JSON.stringify(buckets),
    sample.growth,
    sample.growth,
    sample.calledAt,
    sample.failed ? sample.calledAt : null,
    sample.failed ? sample.lastErrorType : null,
  );
}

/** Stores one bounded, hourly execution sample. Telemetry failures never affect application work. */
export function recordCodeMetric(
  db: Database,
  name: string,
  durationMs: number,
  failed: boolean,
  now = Date.now(),
  lastErrorType: string | null = null,
  peakGrowth = 0,
): void {
  const sample: CallSample = {
    name,
    bucket: bucketStart(now),
    calledAt: new Date(now).toISOString(),
    duration: Math.max(0, Math.round(durationMs)),
    growth: Math.max(0, Math.round(peakGrowth)),
    failed,
    lastErrorType,
  };
  try {
    const existing = db
      .query<StoredMetric, [string, string]>(
        `SELECT name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,
                duration_buckets_json,peak_growth_kb,max_peak_growth_kb,last_called_at,last_error_at,last_error_type
         FROM code_metrics WHERE name=? AND bucket_start=?`,
      )
      .get(sample.name, sample.bucket);
    const buckets = existing ? readBuckets(existing.duration_buckets_json) : emptyBuckets();
    const index = durationBucket(sample.duration);
    buckets[index] = (buckets[index] ?? 0) + 1;
    if (existing) extendBucket(db, sample, buckets);
    else openBucket(db, sample, buckets);
  } catch {
    log("warn", "Code metric could not be stored", { metric: name });
  }
}

export function measure<T>(db: Database, name: string, operation: () => T): T;
export function measure<T>(db: Database, name: string, operation: () => Promise<T>): Promise<T>;
/**
 * A section's duration and what it added to the floor, stored together.
 *
 * The peak is read before and after rather than sampled, because `VmHWM` is monotone: the increment
 * is exactly what this section raised the high-water mark by, and a section that holds 200 MB for
 * eight hundred milliseconds cannot fall between two samples the way it does in `memory`.
 *
 * Two sections that overlap in time each see the growth of both, because there is one process and
 * one mark. That makes every figure here an upper bound on the section's own claim, which is the
 * safe direction -- it names a suspect rather than clearing one -- and it is why the boot phases are
 * measured in sequence inside one transaction, where the numbers are each section's alone.
 */
export function measure<T>(db: Database, name: string, operation: () => T | Promise<T>): T | Promise<T> {
  const started = Date.now();
  const peakBefore = peakKb();
  try {
    const result = operation();
    if (result instanceof Promise)
      return result.then(
        (value) => {
          recordCodeMetric(db, name, Date.now() - started, false, Date.now(), null, peakGrowthKb(peakBefore));
          return value;
        },
        (error: unknown) => {
          recordFailure(db, name, Date.now() - started, error, Date.now(), peakGrowthKb(peakBefore));
          throw error;
        },
      );
    recordCodeMetric(db, name, Date.now() - started, false, Date.now(), null, peakGrowthKb(peakBefore));
    return result;
  } catch (error) {
    recordFailure(db, name, Date.now() - started, error, Date.now(), peakGrowthKb(peakBefore));
    throw error;
  }
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

function sectionReport(metric: SectionTotals, buckets: number[]): CodeAnalyticsSection {
  return {
    name: metric.name,
    calls: metric.calls,
    successes: metric.calls - metric.failures,
    failures: metric.failures,
    failureRate: metric.calls ? round(metric.failures / metric.calls, 4) : 0,
    totalDurationMs: metric.totalDurationMs,
    averageDurationMs: metric.calls ? round(metric.totalDurationMs / metric.calls, 2) : 0,
    minDurationMs: metric.minDurationMs,
    maxDurationMs: metric.maxDurationMs,
    p50DurationMs: percentile(buckets, 0.5),
    p95DurationMs: percentile(buckets, 0.95),
    peakGrowthMb: round(metric.peakGrowthKb / 1024, 1),
    maxPeakGrowthMb: round(metric.maxPeakGrowthKb / 1024, 1),
    lastCalledAt: metric.lastCalledAt,
    lastErrorAt: metric.lastErrorAt,
    lastErrorType: metric.lastErrorType,
  };
}

export type TimingsQuery = {
  /** Only sections whose name contains this, so one subsystem can be asked about on its own. */
  name?: string | undefined;
  /** How many of the slowest sections to return. The full list is a wall nobody reads. */
  limit?: number | undefined;
  /** The per-hour series, which is only wanted when the question is "when", not "what". */
  timeline?: boolean | undefined;
  /**
   * Where to start instead of counting back whole days: `boot` for this process's start, an ISO
   * instant, or a span such as `90m`, `6h` or `2d`. The question after a deploy is what the new
   * build costs, and `days` cannot ask it.
   */
  since?: string | undefined;
};

const SPAN = /^(\d+)(m|h|d)$/;
const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The moment `--since` names, as a number. Throws rather than silently measuring the wrong week. */
function askedFrom(db: Database, value: string, now: number): number {
  if (value === "boot") {
    const bootedAt = readRuntime(db)?.bootedAt;
    if (!bootedAt) throw new Error("This process has not recorded a start time, so `--since boot` has nothing to use");
    return Date.parse(bootedAt);
  }
  const span = SPAN.exec(value);
  if (span) return now - Number(span[1]) * (SPAN_MS[span[2] as string] as number);
  const at = Date.parse(value);
  if (!Number.isFinite(at))
    throw new Error(`Cannot read \`${value}\` as a moment: use boot, an ISO instant, or 90m, 6h, 2d`);
  return at;
}

/**
 * The window a report covers and the name it was narrowed to, as the three parameters every query
 * below takes. `wanted` is empty for "every section", which is a condition SQL can carry rather
 * than a filter this process applies to rows it already built.
 *
 * The queries number their parameters -- `?1` is the window's start wherever it appears -- because
 * each of them names the same value more than once, and a positional list that has to be read
 * against the order the placeholders happen to appear in is a list somebody gets wrong. Named
 * parameters are not the way out: only a handle opened `strict` matches them by bare name, and this
 * report is asked through read-only handles that are not, where a name that matches nothing binds
 * null and answers about an empty window instead of failing.
 */
type Window = { from: string; to: string; wanted: string };

/** A window as the queries below take it. */
function bounds(window: Window): [string, string, string] {
  return [window.from, window.to, window.wanted];
}

/**
 * A section's numbers, added up by SQLite.
 *
 * `timings` claimed 57 MB of a floor that is never given back to answer with 6.8 KB, measured on a
 * copy of production 2026-09-27. It selected every row of the window -- most of 109,784, each
 * carrying an 18-slot JSON histogram -- and folded them into one entry per name here. `code_metrics`
 * gains a row per hour per instrumented section, so that read grew with the archive rather than
 * with the answer, faster than anything else this service stores.
 *
 * `lastErrorType` is the type of the newest failure in the window, which is what the loop that used
 * to do this kept. The subquery reproduces its tie-break as well: it walked buckets in order and
 * replaced the type only on a strictly newer failure, so where two buckets carry the same instant
 * the older bucket's type is the one that survives.
 */
const SECTION_TOTALS = `
  SELECT m.name AS name,
         SUM(m.calls) AS calls,
         SUM(m.failures) AS failures,
         SUM(m.total_duration_ms) AS totalDurationMs,
         MIN(m.min_duration_ms) AS minDurationMs,
         MAX(m.max_duration_ms) AS maxDurationMs,
         SUM(m.peak_growth_kb) AS peakGrowthKb,
         MAX(m.max_peak_growth_kb) AS maxPeakGrowthKb,
         MAX(m.last_called_at) AS lastCalledAt,
         MAX(m.last_error_at) AS lastErrorAt,
         (SELECT f.last_error_type FROM code_metrics f
           WHERE f.name=m.name AND f.bucket_start>=?1 AND f.bucket_start<=?2 AND f.last_error_at IS NOT NULL
           ORDER BY f.last_error_at DESC, f.bucket_start LIMIT 1) AS lastErrorType
  FROM code_metrics m
  WHERE m.bucket_start>=?1 AND m.bucket_start<=?2 AND (?3='' OR instr(lower(m.name),?3)>0)
  GROUP BY m.name`;

/**
 * A stored histogram, or an empty one where the row does not carry the shape `percentile` reads.
 *
 * `readBuckets` answered a malformed or wrong-length body with all zeroes, so a row like that
 * contributed nothing; `json_each` answers it by raising, which would fail the report instead. The
 * two `CASE`s are nested rather than joined with `AND` because only nesting is documented to leave
 * the length check unevaluated when the body is not JSON at all.
 */
const HISTOGRAM_JSON = `CASE WHEN json_valid(m.duration_buckets_json)
     THEN (CASE WHEN json_array_length(m.duration_buckets_json)=${DURATION_BUCKET_LIMITS_MS.length}
             THEN m.duration_buckets_json ELSE '[]' END)
     ELSE '[]' END`;

/**
 * The slots of the sections asked for, summed across the window.
 *
 * Only the sections the answer keeps: p50 and p95 are all a histogram is for, and `--limit` throws
 * most of them away. `slot.type` and the sign keep `readBuckets`'s rule that a slot is a
 * non-negative integer or nothing.
 */
function histograms(db: Database, window: Window, names: string[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (names.length === 0) return result;
  const rows = db
    .query<{ name: string; slot: number; calls: number }, [string, string, string, string]>(
      `SELECT m.name AS name,slot.key AS slot,SUM(slot.value) AS calls
       FROM code_metrics m,json_each(${HISTOGRAM_JSON}) AS slot
       WHERE m.bucket_start>=?1 AND m.bucket_start<=?2
         AND m.name IN (SELECT value FROM json_each(?4))
         AND slot.type='integer' AND slot.value>=0
       GROUP BY m.name,slot.key`,
    )
    .all(...bounds(window), JSON.stringify(names));
  for (const row of rows) {
    const buckets = result.get(row.name) ?? emptyBuckets();
    buckets[row.slot] = (buckets[row.slot] ?? 0) + row.calls;
    result.set(row.name, buckets);
  }
  return result;
}

/**
 * The per-hour series, asked for only when it is wanted.
 *
 * Narrowed by the same `wanted` as the totals: a name filter whose two halves describe different
 * sections is a report that contradicts itself.
 */
function timelineOf(db: Database, window: Window): CodeAnalyticsReport["timeline"] {
  return db
    .query<{ bucketStart: string; calls: number; failures: number; totalDurationMs: number }, [string, string, string]>(
      `SELECT bucket_start AS bucketStart,SUM(calls) AS calls,SUM(failures) AS failures,
              SUM(total_duration_ms) AS totalDurationMs
       FROM code_metrics
       WHERE bucket_start>=?1 AND bucket_start<=?2 AND (?3='' OR instr(lower(name),?3)>0)
       GROUP BY bucket_start ORDER BY bucket_start`,
    )
    .all(...bounds(window))
    .map((row) => ({
      ...row,
      averageDurationMs: row.calls ? round(row.totalDurationMs / row.calls, 2) : 0,
    }));
}

export function codeAnalytics(db: Database, days = 7, now = Date.now(), query: TimingsQuery = {}): CodeAnalyticsReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Code analytics days must be between 1 and 90");
  const until = new Date(now).toISOString();
  // A named moment is measured in whole buckets only: the one it falls inside describes both
  // sides of it. Counting back whole days keeps the older behaviour, where the oldest partial hour
  // is a rounding error rather than the thing being asked about.
  const asked = query.since ? askedFrom(db, query.since, now) : null;
  const opens = asked === null ? now - days * 24 * 3_600_000 : Math.ceil(asked / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
  const straddled = asked === null || opens === asked ? null : bucketStart(asked);
  const since = new Date(asked ?? opens).toISOString();
  const firstBucket = asked === null ? bucketStart(opens) : new Date(opens).toISOString();
  const window: Window = { from: firstBucket, to: until, wanted: query.name?.toLowerCase() ?? "" };
  const metrics = db
    .query<SectionTotals, [string, string, string]>(SECTION_TOTALS)
    .all(...bounds(window))
    .sort((left, right) => {
      if (right.totalDurationMs !== left.totalDurationMs) return right.totalDurationMs - left.totalDurationMs;
      return left.name.localeCompare(right.name);
    });
  const calls = metrics.reduce((sum, metric) => sum + metric.calls, 0);
  const failures = metrics.reduce((sum, metric) => sum + metric.failures, 0);
  const totalDurationMs = metrics.reduce((sum, metric) => sum + metric.totalDurationMs, 0);
  // Named for what it is rather than after the reader it is summed from: `peakGrowthKb` is the
  // imported function, and shadowing it here would leave the next edit unable to call it.
  const growthKb = metrics.reduce((sum, metric) => sum + metric.peakGrowthKb, 0);
  const answered = query.limit ? metrics.slice(0, query.limit) : metrics;
  const buckets = histograms(
    db,
    window,
    answered.map((metric) => metric.name),
  );
  return {
    since,
    until,
    // What the window actually covers, which is not what was asked for once `--since` names a
    // moment inside an hour: a report saying 7 days over a 40-minute window is the wrong answer.
    days: asked === null ? days : round((now - opens) / 86_400_000, 3),
    straddled,
    totals: {
      calls,
      successes: calls - failures,
      failures,
      failureRate: calls ? round(failures / calls, 4) : 0,
      totalDurationMs,
      averageDurationMs: calls ? round(totalDurationMs / calls, 2) : 0,
      peakGrowthMb: round(growthKb / 1024, 1),
    },
    sections: answered.map((metric) => sectionReport(metric, buckets.get(metric.name) ?? emptyBuckets())),
    timeline: query.timeline ? timelineOf(db, window) : [],
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
