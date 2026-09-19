import { expect, test } from "bun:test";
import { memoryReport, sampleMemory } from "../src/runtime/observability.js";
import { openDatabase } from "../src/storage/database.js";

const insert = (db: ReturnType<typeof openDatabase>, at: string, rss: number, kills: number, boot: string) =>
  db
    .query(
      "INSERT INTO memory_samples(sampled_at,boot_id,rss_mb,heap_used_mb,cgroup_current_mb,cgroup_peak_mb,cgroup_limit_mb,oom_kills) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(at, boot, rss, rss / 2, rss + 20, rss + 40, 2048, kills);

test("a sample is stored and old ones are dropped", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  insert(db, "2026-05-01T00:00:00.000Z", 100, 0, "old");
  sampleMemory(db, now);
  const rows = db.query<{ sampled_at: string }, []>("SELECT sampled_at FROM memory_samples").all();
  expect(rows.map((row) => row.sampled_at)).toEqual(["2026-09-19T12:00:00.000Z"]);
});

test("the report finds the peak, time near the limit, and kills from the counter's rise", () => {
  const db = openDatabase(":memory:");
  insert(db, "2026-09-18T10:00:00.000Z", 400, 2, "a");
  insert(db, "2026-09-18T10:05:00.000Z", 1800, 2, "a");
  insert(db, "2026-09-18T10:10:00.000Z", 300, 3, "b");
  insert(db, "2026-09-19T09:00:00.000Z", 500, 3, "b");
  const report = memoryReport(db, 7, Date.parse("2026-09-19T12:00:00.000Z"));
  expect(report.oomKills).toBe(1);
  expect(report.peak).toEqual({ at: "2026-09-18T10:05:00.000Z", rssMb: 1800, containerMb: 1820 });
  expect(report.days).toHaveLength(2);
  const [first] = report.days;
  expect(first).toMatchObject({
    day: "2026-09-18",
    samples: 3,
    maxRssMb: 1800,
    samplesAbovePressure: 1,
    oomKills: 1,
    boots: 2,
  });
});
