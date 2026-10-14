import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { collectionCost } from "../src/reports/collectionCost.js";
import { measure, recordCodeMetric } from "../src/runtime/metricRecording.js";
import { openDatabase } from "../src/storage/database.js";
import { anAttempt } from "./fixtures/build.js";

const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });

test("collection cost separates child, overlapping collection, and exact parent sections", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const at = new Date(now - 3_600_000).toISOString();
  // A heavy source: the child reports the whole size it reached, twice, and both are kept -- the
  // worst is what the container has to survive, the average is what a normal run looks like.
  anAttempt(db, "qwen-blog", null, at, { peakRssMb: 417 });
  anAttempt(db, "qwen-blog", null, new Date(now - 7_200_000).toISOString(), { peakRssMb: 317 });
  // The child collector's metric lives in the same table but is not parent-process growth.
  recordCodeMetric(db, "source.collect:qwen-blog", 120, false, now, null, 200 * 1024);
  recordCodeMetric(db, "source.decode:qwen-blog", 120, false, now, null, 12 * 1024);
  recordCodeMetric(db, "source.persist:qwen-blog", 120, false, now, null, 89 * 1024);
  // Concurrent light collectors can each observe the same 40 MB rise. No verdict may name either
  // as the cause; their synchronous persistence has a separate, attributable measurement.
  anAttempt(db, "arena", null, at);
  recordCodeMetric(db, "source.collect:arena", 120, false, now - 3_600_000, null, 40 * 1024);
  recordCodeMetric(db, "source.collect:arena", 120, false, now, null, 8 * 1024);
  recordCodeMetric(db, "source.collect:deepseek-updates", 120, false, now, null, 40 * 1024);
  recordCodeMetric(db, "source.persist:arena", 120, false, now, null, 2 * 1024);

  const report = collectionCost(db, config, 7, now);
  const child = report.sources.find((source) => source.id === "qwen-blog");
  const arena = report.sources.find((source) => source.id === "arena");
  expect(child).toMatchObject({
    lane: "child",
    collections: 2,
    childPeakMb: 417,
    averageChildPeakMb: 367,
    averageObservedDuringCollectionMb: null,
    averageAddedByDecodeMb: 12,
    averageAddedByPersistenceMb: 89,
  });
  // Two readings of one section are one mean, 40 and 8 across two hourly buckets: the fold's
  // buckets are summed, not compared, so an hour's worth and a day's worth read the same way.
  expect(arena).toMatchObject({
    lane: "in process",
    childPeakMb: null,
    averageObservedDuringCollectionMb: 24,
    averageAddedByDecodeMb: null,
    averageAddedByPersistenceMb: 2,
  });
  expect(report.sources.find((source) => source.id === "deepseek-updates")?.averageObservedDuringCollectionMb).toBe(40);
  expect(report).not.toHaveProperty("shouldBeCollectedInAChild");
  db.close();
});

test("collection cost answers about the registry, not about every source that ever ran", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  // The fold keeps a row for everything that ever ran, including what has since been retired. A
  // `GROUP BY` over it would report on a source nobody can act on.
  anAttempt(db, "retired-source", null, new Date(now - 3_600_000).toISOString(), { peakRssMb: 900 });
  const report = collectionCost(db, config, 7, now);
  expect(report.sources.map((source) => source.id)).not.toContain("retired-source");
  db.close();
});

test("one restart's climb does not become a source's persistence cost", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  anAttempt(db, "arena", null, new Date(now - 3_600_000).toISOString());
  // A fresh process's peak climbs to its working size once, and the section that happens to run
  // during it is charged the whole 250 MB. It is one call of six hundred, and the report may not
  // put a quarter of a gigabyte against a source for it: production showed eight at once this way,
  // on a day it restarted nineteen times.
  recordCodeMetric(db, "source.persist:arena", 120, false, now, null, 250 * 1024);
  for (let call = 0; call < 599; call++) recordCodeMetric(db, "source.persist:arena", 120, false, now, null, 0);
  const arena = collectionCost(db, config, 7, now).sources.find((source) => source.id === "arena");
  expect(arena?.averageAddedByPersistenceMb).toBeCloseTo(0.4, 1);
  db.close();
});

test("a section's first call in a process is charged no peak growth", () => {
  const db = openDatabase(":memory:");
  // `measure` reads the peak before the section, except the first time it sees the name: that call
  // carries what running the section for the first time costs the process -- JIT, prepared
  // statements, SQLite's page cache -- and the next call never pays it again. Allocating here is
  // what makes the gate visible: charged, this call would be the largest reading in the report.
  const held: Uint8Array[] = [];
  measure(db, "source.persist:arena", () => {
    for (let block = 0; block < 64; block++) held.push(new Uint8Array(1024 * 1024).fill(block));
  });
  expect(held.length).toBe(64);
  const first = db
    .query<{ calls: number; growth: number }, []>(
      "SELECT SUM(calls) AS calls,SUM(peak_growth_kb) AS growth FROM code_metrics WHERE name='source.persist:arena'",
    )
    .get();
  expect(first).toMatchObject({ calls: 1, growth: 0 });
  db.close();
});
