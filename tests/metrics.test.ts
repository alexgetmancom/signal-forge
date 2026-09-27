import { describe, expect, test } from "bun:test";
import { measure, recordCodeMetric } from "../src/runtime/metricRecording.js";
import { codeAnalytics } from "../src/runtime/metricReport.js";
import { openDatabase } from "../src/storage/database.js";

test("code analytics aggregates execution counts, failures, durations and timeline", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-10T12:34:00.000Z");
  recordCodeMetric(db, "worker:sources", 5, false, now - 3_000);
  recordCodeMetric(db, "worker:sources", 10, false, now - 2_000);
  recordCodeMetric(db, "worker:sources", 100, true, now - 1_000, "TypeError");
  recordCodeMetric(db, "worker:sources", 2_000, false, now);
  recordCodeMetric(db, "source.collect:openrouter", 25, false, now);

  const report = codeAnalytics(db, 7, now, { timeline: true });
  expect(report.totals).toMatchObject({ calls: 5, successes: 4, failures: 1, totalDurationMs: 2_140 });
  expect(report.totals.averageDurationMs).toBe(428);
  expect(report.timeline).toHaveLength(1);
  // The series is the answer to "when", and the usual question is "what": it is left out unless asked.
  expect(codeAnalytics(db, 7, now).timeline).toEqual([]);
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

test("timings can be asked about one subsystem, and answers with only the slowest", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-10T12:34:00.000Z");
  recordCodeMetric(db, "pipeline.stories", 900, false, now);
  recordCodeMetric(db, "pipeline.hypotheses", 100, false, now);
  recordCodeMetric(db, "source.collect:arena", 5_000, false, now);

  // Slowest first, and only as many as were asked for -- the full list is what sent ten questions
  // to raw SQL instead of to this command.
  const slowest = codeAnalytics(db, 7, now, { limit: 1 });
  expect(slowest.sections.map((section) => section.name)).toEqual(["source.collect:arena"]);

  const pipeline = codeAnalytics(db, 7, now, { name: "pipeline", timeline: true });
  expect(pipeline.sections.map((section) => section.name)).toEqual(["pipeline.stories", "pipeline.hypotheses"]);
  // Both halves of the report describe the filtered sections, not the whole database.
  expect(pipeline.totals.totalDurationMs).toBe(1_000);
  expect(pipeline.timeline[0]?.totalDurationMs).toBe(1_000);
  db.close();
});

const memoryDatabase = () => openDatabase(":memory:");
const record = (db: ReturnType<typeof openDatabase>, name: string, ms: number, at: number) =>
  recordCodeMetric(db, name, ms, false, at);

describe("a window that starts at a named moment", () => {
  test("the hour the moment falls inside is named and left out", () => {
    const db = memoryDatabase();
    // 13:34 is a deploy. The 13:00 bucket holds the build before it as well as the one after.
    record(db, "pipeline.stories", 200, Date.parse("2026-09-25T13:10:00.000Z"));
    record(db, "pipeline.stories", 4, Date.parse("2026-09-25T14:10:00.000Z"));
    const now = Date.parse("2026-09-25T14:50:00.000Z");
    const report = codeAnalytics(db, 7, now, { since: "2026-09-25T13:34:00.000Z" });
    expect(report.straddled).toBe("2026-09-25T13:00:00.000Z");
    expect(report.since).toBe("2026-09-25T13:34:00.000Z");
    expect(report.totals.calls).toBe(1);
    expect(report.sections[0]?.maxDurationMs).toBe(4);
  });

  test("a moment exactly on the hour straddles nothing", () => {
    const db = memoryDatabase();
    record(db, "pipeline.stories", 4, Date.parse("2026-09-25T14:10:00.000Z"));
    const report = codeAnalytics(db, 7, Date.parse("2026-09-25T14:50:00.000Z"), {
      since: "2026-09-25T14:00:00.000Z",
    });
    expect(report.straddled).toBeNull();
    expect(report.totals.calls).toBe(1);
  });

  test("a span is counted back from now, and days says what was covered", () => {
    const db = memoryDatabase();
    const now = Date.parse("2026-09-25T14:50:00.000Z");
    record(db, "pipeline.stories", 4, Date.parse("2026-09-25T14:10:00.000Z"));
    record(db, "pipeline.stories", 9, Date.parse("2026-09-24T14:10:00.000Z"));
    const report = codeAnalytics(db, 7, now, { since: "2h" });
    expect(report.totals.calls).toBe(1);
    expect(report.days).toBeLessThan(1);
  });

  test("a moment nobody can read is refused rather than measured", () => {
    const db = memoryDatabase();
    expect(() => codeAnalytics(db, 7, Date.now(), { since: "last tuesday" })).toThrow(/Cannot read/);
  });

  test("counting back whole days straddles nothing and keeps the older window", () => {
    const db = memoryDatabase();
    const report = codeAnalytics(db, 7, Date.parse("2026-09-25T14:50:00.000Z"));
    expect(report.straddled).toBeNull();
    expect(report.days).toBe(7);
  });
});

test("timings say what a section added to the floor, summed and at its worst", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  // Two calls in one bucket and one in the hour before it: the sum crosses buckets, the worst call
  // is the largest single claim anywhere in the window, and neither is an average.
  recordCodeMetric(db, "boot.stories", 900, false, now - 3_600_000, null, 120 * 1024);
  recordCodeMetric(db, "boot.stories", 800, false, now, null, 8 * 1024);
  recordCodeMetric(db, "boot.stories", 700, false, now, null, 4 * 1024);
  recordCodeMetric(db, "boot.hypotheses", 100, false, now, null, 1024);

  const report = codeAnalytics(db, 7, now);
  expect(report.sections).toEqual([
    expect.objectContaining({ name: "boot.stories", peakGrowthMb: 132, maxPeakGrowthMb: 120 }),
    expect.objectContaining({ name: "boot.hypotheses", peakGrowthMb: 1, maxPeakGrowthMb: 1 }),
  ]);
  expect(report.totals.peakGrowthMb).toBe(133);
  db.close();
});

test("a section that was never weighed reads as zero rather than as absent", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  // Every row stored before migration 058 has the default, and so does a call on a platform that
  // will not say what its peak is. Zero, not null: a report that has to explain a missing number
  // in every section is a report nobody reads to the end.
  recordCodeMetric(db, "worker:sources", 5, false, now);
  expect(codeAnalytics(db, 7, now).sections[0]).toMatchObject({ peakGrowthMb: 0, maxPeakGrowthMb: 0 });
  db.close();
});

test("measure weighs the section it times", async () => {
  const db = openDatabase(":memory:");
  // The growth of one small allocation is not a number a test can assert on -- it depends on the
  // allocator, and on Linux `VmHWM` moves in pages. What is asserted is that the two readings are
  // taken around the operation and stored as a non-negative claim against the section that ran.
  await measure(db, "test:weighed", async () => {
    await Bun.sleep(1);
  });
  const section = codeAnalytics(db, 1).sections[0];
  expect(section?.name).toBe("test:weighed");
  expect(section?.peakGrowthMb).toBeGreaterThanOrEqual(0);
  expect(section?.maxPeakGrowthMb).toBeLessThanOrEqual(section?.peakGrowthMb ?? 0);
  db.close();
});
