import { expect, test } from "bun:test";
import { codeAnalytics, measure, recordCodeMetric } from "../src/runtime/metrics.js";
import { openDatabase } from "../src/storage/database.js";

test("code analytics aggregates execution counts, failures, durations and timeline", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-10T12:34:00.000Z");
  recordCodeMetric(db, "worker:sources", 5, false, now - 3_000);
  recordCodeMetric(db, "worker:sources", 10, false, now - 2_000);
  recordCodeMetric(db, "worker:sources", 100, true, now - 1_000, "TypeError");
  recordCodeMetric(db, "worker:sources", 2_000, false, now);
  recordCodeMetric(db, "source.collect:openrouter", 25, false, now);

  const report = codeAnalytics(db, 7, now);
  expect(report.totals).toMatchObject({ calls: 5, successes: 4, failures: 1, totalDurationMs: 2_140 });
  expect(report.totals.averageDurationMs).toBe(428);
  expect(report.timeline).toHaveLength(1);
  expect(report.sections[0]).toMatchObject({
    name: "worker:sources",
    calls: 4,
    successes: 3,
    failures: 1,
    failureRate: 0.25,
    totalDurationMs: 2_115,
    averageDurationMs: 528.75,
    minDurationMs: 5,
    maxDurationMs: 2_000,
    p50DurationMs: 10,
    p95DurationMs: 2_500,
    lastErrorType: "TypeError",
  });
  db.close();
});

test("measure records async failures and preserves the original error", async () => {
  const db = openDatabase(":memory:");
  const expected = new RangeError("do not persist this message");
  let caught: unknown;
  try {
    await measure(db, "test:async", async () => {
      await Bun.sleep(1);
      throw expected;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(expected);
  expect(codeAnalytics(db, 1).sections).toEqual([
    expect.objectContaining({ name: "test:async", calls: 1, failures: 1, lastErrorType: "RangeError" }),
  ]);
  expect(JSON.stringify(codeAnalytics(db, 1))).not.toContain("do not persist this message");
  db.close();
});
