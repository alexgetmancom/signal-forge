/**
 * An hour of code metrics past a short horizon becomes a day of them.
 *
 * `code_metrics` gains a row per hour per instrumented section, 590 names on production, which is
 * 1.17 MB a day and the only table in the database that grows with how much of itself the service
 * has instrumented rather than with what it collected. Ninety days of that is a steady state of
 * 105 MB, so the horizon was cut to thirty and the comment where it was cut said what the real
 * answer was: fold the old hours into days and the ninety come back for a few megabytes.
 *
 * Measured on a copy of production 2026-10-03: 175,366 rows over 24 days, 590 names. Folded to one
 * row per name per day that is 14,160 -- twelve times fewer -- and the two days left at hourly
 * resolution are 28,000 of their own. Ninety days then costs around 7 MB where thirty hourly cost
 * 35.
 *
 * What is lost is resolution, and only beyond two days: `timings`' timeline shows one point per
 * hour inside the horizon and one per day outside it. Every other number in that report is a sum,
 * a min or a max over the window and comes back identical, which is the reason this is a fold and
 * not a second table -- `percentile` sums the eighteen histogram slots either way, and a report
 * reading two resolutions in one query is the design this avoids having.
 *
 * Folded in TypeScript rather than in SQL. The histogram is eighteen slots that have to be added
 * element by element, which in SQLite is `json_each` with a `GROUP BY key` and a
 * `json_group_array` inside an upsert -- unreadable, and this runs once a day over a few thousand
 * rows.
 */
import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { writeTransaction } from "../storage/transaction.js";
import { DURATION_BUCKET_LIMITS_MS, emptyBuckets } from "./metricBuckets.js";

/**
 * How long the hourly rows are kept before the day replaces them.
 *
 * Two days, which is what `timings`' default window of seven already renders mostly as days and
 * what every question about "it was slow this morning" reaches back over.
 */
export const HOURLY_METRIC_DAYS = 2;

/**
 * The midnight before which every row is one per day rather than one per hour.
 *
 * Both the fold and the reports need it, and for opposite reasons. The fold must not touch a day
 * with hours still inside the horizon. A report must not open its window in the middle of a folded
 * day: the day is one row at midnight, so a window opening at 16:00 either takes all twenty-four
 * hours of it or none, and before this existed it took none -- 473 of 505 sections answered
 * differently over a seven-day window on a copy of production, every one of them by the part of
 * the oldest day the window used to reach into.
 */
export function foldedBefore(now: number): string {
  return `${new Date(now - HOURLY_METRIC_DAYS * 24 * 3_600_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** One name's numbers for one day, as they are added up. */
type Folded = {
  calls: number;
  failures: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  buckets: number[];
  lastCalledAt: string;
  lastErrorAt: string | null;
  lastErrorType: string | null;
  peakGrowthKb: number;
  maxPeakGrowthKb: number;
};

type Row = {
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
  peak_growth_kb: number;
  max_peak_growth_kb: number;
};

function slots(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== DURATION_BUCKET_LIMITS_MS.length) return emptyBuckets();
    return parsed.map((item) => (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : 0));
  } catch {
    return emptyBuckets();
  }
}

/**
 * Two rows of the same name added together.
 *
 * `lastErrorType` keeps the type belonging to the newest `last_error_at`, and where two rows carry
 * the same instant the earlier bucket wins -- which is the tie-break `timings`' own subquery
 * already has (`ORDER BY f.last_error_at DESC, f.bucket_start LIMIT 1`), so a folded day answers
 * the same type the hours it replaced did. Rows are added in `bucket_start` order for that to hold.
 */
function add(into: Folded | undefined, row: Row): Folded {
  const buckets = slots(row.duration_buckets_json);
  if (!into)
    return {
      calls: row.calls,
      failures: row.failures,
      totalDurationMs: row.total_duration_ms,
      minDurationMs: row.min_duration_ms,
      maxDurationMs: row.max_duration_ms,
      buckets,
      lastCalledAt: row.last_called_at,
      lastErrorAt: row.last_error_at,
      lastErrorType: row.last_error_type,
      peakGrowthKb: row.peak_growth_kb,
      maxPeakGrowthKb: row.max_peak_growth_kb,
    };
  const newerError = row.last_error_at !== null && (into.lastErrorAt === null || row.last_error_at > into.lastErrorAt);
  return {
    calls: into.calls + row.calls,
    failures: into.failures + row.failures,
    totalDurationMs: into.totalDurationMs + row.total_duration_ms,
    minDurationMs: Math.min(into.minDurationMs, row.min_duration_ms),
    maxDurationMs: Math.max(into.maxDurationMs, row.max_duration_ms),
    buckets: into.buckets.map((count, slot) => count + (buckets[slot] ?? 0)),
    lastCalledAt: row.last_called_at > into.lastCalledAt ? row.last_called_at : into.lastCalledAt,
    lastErrorAt:
      row.last_error_at !== null && (into.lastErrorAt === null || row.last_error_at > into.lastErrorAt)
        ? row.last_error_at
        : into.lastErrorAt,
    lastErrorType: newerError ? row.last_error_type : into.lastErrorType,
    peakGrowthKb: into.peakGrowthKb + row.peak_growth_kb,
    maxPeakGrowthKb: Math.max(into.maxPeakGrowthKb, row.max_peak_growth_kb),
  };
}

/** Midnight of a day, and midnight of the day after it: the half-open range one day's rows live in. */
function dayRange(day: string): [string, string] {
  const start = `${day}T00:00:00.000Z`;
  return [start, new Date(Date.parse(start) + 24 * 3_600_000).toISOString()];
}

/**
 * The days wholly past the horizon that still hold an hour other than their own midnight.
 *
 * Wholly past: the bound is the midnight beginning the horizon's day, not the instant the horizon
 * falls on, so a day is never folded while hours of it are still inside the hourly window. A day
 * already folded has one row per name at midnight and is not selected, which is what makes this
 * idempotent -- it runs on every status cycle and does nothing on all but the first of a day.
 */
function foldableDays(db: Database, beforeDay: string): string[] {
  return db
    .query<{ day: string }, [string]>(
      `SELECT DISTINCT substr(bucket_start,1,10) AS day FROM code_metrics
       WHERE bucket_start < ? AND substr(bucket_start,11) <> 'T00:00:00.000Z'
       ORDER BY day`,
    )
    .all(beforeDay)
    .map((row) => row.day);
}

/**
 * Replace one day's hourly rows with one row per name.
 *
 * Delete then insert, inside one transaction, rather than upsert into the midnight row: the
 * midnight hour is itself one of the rows being folded, and an upsert that reads a row it is in the
 * middle of rewriting is the kind of thing that works until the day a section is only ever called
 * at midnight.
 */
function foldOneDay(db: Database, day: string): number {
  const [start, end] = dayRange(day);
  const rows = db
    .query<Row, [string, string]>(
      "SELECT * FROM code_metrics WHERE bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start",
    )
    .all(start, end);
  const folded = new Map<string, Folded>();
  for (const row of rows) folded.set(row.name, add(folded.get(row.name), row));
  writeTransaction(db, () => {
    db.query("DELETE FROM code_metrics WHERE bucket_start >= ? AND bucket_start < ?").run(start, end);
    const insert = db.query(
      `INSERT INTO code_metrics(
         name, bucket_start, calls, failures, total_duration_ms, min_duration_ms, max_duration_ms,
         duration_buckets_json, last_called_at, last_error_at, last_error_type, peak_growth_kb,
         max_peak_growth_kb
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const [name, one] of folded)
      insert.run(
        name,
        start,
        one.calls,
        one.failures,
        one.totalDurationMs,
        one.minDurationMs,
        one.maxDurationMs,
        JSON.stringify(one.buckets),
        one.lastCalledAt,
        one.lastErrorAt,
        one.lastErrorType,
        one.peakGrowthKb,
        one.maxPeakGrowthKb,
      );
  });
  return rows.length - folded.size;
}

/** How many rows the fold removed. Nothing is deleted that is not added into the day it belonged to. */
export function foldCodeMetricDays(db: Database, now = Date.now()): number {
  const beforeDay = foldedBefore(now);
  let removed = 0;
  try {
    for (const day of foldableDays(db, beforeDay)) removed += foldOneDay(db, day);
  } catch (error) {
    log("warn", "Code metric day fold failed", { errorType: error instanceof Error ? error.message : "unknown" });
  }
  return removed;
}
