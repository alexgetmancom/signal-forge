import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { bucketStart, DURATION_BUCKET_LIMITS_MS, emptyBuckets } from "./metricBuckets.js";
import { peakGrowthKb, peakKb } from "./peak.js";

/**
 * How long an hour of code metrics is kept, and the longest window any report of them may ask for.
 *
 * Ninety days was the horizon while nobody had weighed the table. It is 1.17 MB a day after
 * migration 075 -- 173,162 rows for 23 days of production, 590 names in hourly buckets -- so ninety
 * days is a steady state of 105 MB for a table whose default window is seven days, and it was the
 * second-largest thing in the database on the way there.
 *
 * Exported because a horizon that only retention knows about is a report that answers short:
 * `timings` and `collection-cost` cap their `days` at this, so a question that reaches past the
 * rows is refused rather than answered from the days that happen to be left. `collection-cost`
 * reads child peaks from `source_collection_days`, which keeps ninety, and parent growth from here;
 * one cap for the whole report is why its two halves cannot disagree about the window.
 *
 * Thirty days of hourly resolution, rather than a fold into days beyond a short horizon. The fold
 * is what would buy ninety days back for a few megabytes, and it is not written: every slot of an
 * 18-bucket histogram has to be summed per day and `timings` has to read two resolutions in one
 * timeline, which is a design, not a constant.
 */
export const METRIC_DAYS = 30;
const RETENTION_DAYS = METRIC_DAYS;
function durationBucket(durationMs: number): number {
  const index = DURATION_BUCKET_LIMITS_MS.findIndex((limit) => durationMs <= limit);
  return index === -1 ? DURATION_BUCKET_LIMITS_MS.length - 1 : index;
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
      .query<{ duration_buckets_json: string }, [string, string]>(
        "SELECT duration_buckets_json FROM code_metrics WHERE name=? AND bucket_start=?",
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
export function measure<T>(db: Database, name: string, operation: () => T): T;
export function measure<T>(db: Database, name: string, operation: () => Promise<T>): Promise<T>;
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

export function pruneCodeMetrics(db: Database, now = Date.now()): void {
  const before = new Date(now - RETENTION_DAYS * 24 * 3_600_000).toISOString();
  try {
    db.query("DELETE FROM code_metrics WHERE bucket_start<?").run(before);
  } catch {
    log("warn", "Code metric retention cleanup failed");
  }
}
