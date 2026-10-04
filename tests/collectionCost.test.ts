import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { collectionCost } from "../src/reports/collectionCost.js";
import { recordCodeMetric } from "../src/runtime/metricRecording.js";
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
    observedDuringCollectionMb: null,
    addedByDecodeMb: 12,
    addedByPersistenceMb: 89,
  });
  expect(arena).toMatchObject({
    lane: "in process",
    collections: 1,
    childPeakMb: null,
    observedDuringCollectionMb: 40,
    addedByDecodeMb: null,
    addedByPersistenceMb: 2,
  });
  expect(report.sources.find((source) => source.id === "deepseek-updates")?.observedDuringCollectionMb).toBe(40);
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
