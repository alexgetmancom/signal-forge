import type { Database } from "bun:sqlite";
import { round } from "../numbers.js";
import { bucketStart, DURATION_BUCKET_LIMITS_MS, emptyBuckets, METRIC_BUCKET_MS } from "./metricBuckets.js";
import { foldedBefore } from "./metricFold.js";
import { askedFrom, bounds, type TimingsQuery, type Window } from "./timingWindow.js";

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
  // Past the fold the rows are one per day, so a window opening at 16:00 on an older day either
  // takes all twenty-four hours of that day or none of them. It is opened at midnight instead, and
  // `since` says the midnight rather than the moment asked for: a report that quietly dropped
  // sixteen hours of the oldest day is the version of this that shipped for an afternoon.
  const aligned =
    opens < Date.parse(foldedBefore(now))
      ? Date.parse(`${new Date(opens).toISOString().slice(0, 10)}T00:00:00.000Z`)
      : opens;
  const snapped = aligned !== opens;
  const since = new Date(snapped ? aligned : (asked ?? opens)).toISOString();
  const firstBucket = asked === null && !snapped ? bucketStart(opens) : new Date(aligned).toISOString();
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
    days: asked === null && !snapped ? days : round((now - aligned) / 86_400_000, 3),
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
