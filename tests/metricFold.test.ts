import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { foldCodeMetricDays, HOURLY_METRIC_DAYS } from "../src/runtime/metricFold.js";
import { codeAnalytics } from "../src/runtime/metricReport.js";
import { openDatabase } from "../src/storage/database.js";

const now = Date.parse("2026-10-03T12:30:00.000Z");
const HOUR = 3_600_000;

/**
 * A week of hourly rows for two sections, with a failure in the middle of it.
 *
 * Written straight rather than through `measure`, because what is being tested is that a day of
 * rows adds up to the same report as the hours it replaced, and that needs the hours to be
 * arbitrary rather than whatever the clock did during the test.
 */
function aWeekOfHours(db: Database): void {
  const insert = db.query(
    `INSERT INTO code_metrics(
       name, bucket_start, calls, failures, total_duration_ms, min_duration_ms, max_duration_ms,
       duration_buckets_json, last_called_at, last_error_at, last_error_type, peak_growth_kb,
       max_peak_growth_kb
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let hour = 0; hour < 7 * 24; hour += 1) {
    const at = new Date(now - hour * HOUR);
    const bucket = new Date(Math.floor(at.getTime() / HOUR) * HOUR).toISOString();
    const buckets = Array.from({ length: 18 }, (_, slot) => (slot === hour % 18 ? 1 + (hour % 3) : 0));
    const failing = hour % 29 === 0;
    insert.run(
      hour % 2 === 0 ? "poll.cycle" : "status.alerts",
      bucket,
      3 + (hour % 5),
      failing ? 1 : 0,
      100 + hour,
      1 + (hour % 7),
      50 + hour,
      JSON.stringify(buckets),
      new Date(Math.floor(at.getTime() / HOUR) * HOUR + 59_000).toISOString(),
      failing ? new Date(Math.floor(at.getTime() / HOUR) * HOUR + 1_000).toISOString() : null,
      failing ? `Failure${hour}` : null,
      hour % 11,
      hour % 13,
    );
  }
}

function rowsOf(db: Database): { name: string; bucket_start: string }[] {
  return db
    .query<{ name: string; bucket_start: string }, []>("SELECT name,bucket_start FROM code_metrics ORDER BY 2,1")
    .all();
}

test("a folded day answers the same totals, failures and percentiles as the hours it replaced", () => {
  const db = openDatabase(":memory:");
  aWeekOfHours(db);
  const before = codeAnalytics(db, 30, now);

  const removed = foldCodeMetricDays(db, now);

  expect(removed).toBeGreaterThan(90);
  const after = codeAnalytics(db, 30, now);
  expect(after.totals).toEqual(before.totals);
  // Every section: calls, failures, the durations, the peaks, the newest error and its type, and
  // the percentiles read off the eighteen summed slots.
  expect(after.sections).toEqual(before.sections);
  db.close();
});

test("a window reaching past the fold opens at midnight, and says so", () => {
  const db = openDatabase(":memory:");
  aWeekOfHours(db);
  const folded = codeAnalytics(db, 7, now);

  // Asked at 12:30 for seven days, which lands mid-day on a folded day. A day beyond the fold is
  // one row at midnight, so the window opens there and `since` is the midnight, not the 12:30.
  expect(folded.since).toBe("2026-09-26T00:00:00.000Z");
  expect(folded.days).toBeGreaterThan(7);
  // Inside the hourly horizon nothing is snapped: the rows are still hourly and the moment holds.
  expect(codeAnalytics(db, 1, now).since).toBe("2026-10-02T12:30:00.000Z");
  // And the fold does not move it again: alignment is about where the rows are, not whether the
  // fold has run yet.
  foldCodeMetricDays(db, now);
  expect(codeAnalytics(db, 7, now).since).toBe(folded.since);
  db.close();
});

test("the fold leaves the hourly horizon alone and runs again without doing anything", () => {
  const db = openDatabase(":memory:");
  aWeekOfHours(db);
  const hourly = `${new Date(now - HOURLY_METRIC_DAYS * 24 * HOUR).toISOString().slice(0, 10)}T00:00:00.000Z`;

  foldCodeMetricDays(db, now);
  const rows = rowsOf(db);

  // Inside the horizon, one row an hour, untouched.
  const inside = rows.filter((row) => row.bucket_start >= hourly);
  expect(inside.length).toBeGreaterThan(40);
  expect(inside.some((row) => !row.bucket_start.endsWith("T00:00:00.000Z"))).toBe(true);
  // Outside it, one row per name per day and nothing else.
  const outside = rows.filter((row) => row.bucket_start < hourly);
  expect(outside.every((row) => row.bucket_start.endsWith("T00:00:00.000Z"))).toBe(true);
  expect(new Set(outside.map((row) => `${row.name} ${row.bucket_start}`)).size).toBe(outside.length);

  // Idempotent: a day already one row per name is not a day with hours left to fold.
  expect(foldCodeMetricDays(db, now)).toBe(0);
  expect(rowsOf(db)).toEqual(rows);
  db.close();
});

test("a folded day keeps the type of the newest failure in it", () => {
  const db = openDatabase(":memory:");
  const insert = db.query(
    `INSERT INTO code_metrics(
       name, bucket_start, calls, failures, total_duration_ms, min_duration_ms, max_duration_ms,
       duration_buckets_json, last_called_at, last_error_at, last_error_type, peak_growth_kb,
       max_peak_growth_kb
     ) VALUES(?,?,1,1,10,1,10,'[]',?,?,?,0,0)`,
  );
  const day = "2026-09-20";
  for (const [hour, type] of [
    ["03", "Early"],
    ["09", "Newest"],
    ["05", "Middle"],
  ] as const)
    insert.run(
      "poll.cycle",
      `${day}T${hour}:00:00.000Z`,
      `${day}T${hour}:30:00.000Z`,
      `${day}T${hour}:10:00.000Z`,
      type,
    );

  foldCodeMetricDays(db, now);

  expect(
    db.query<{ last_error_at: string; last_error_type: string }, []>("SELECT * FROM code_metrics").get(),
  ).toMatchObject({ last_error_at: `${day}T09:10:00.000Z`, last_error_type: "Newest" });
  db.close();
});
