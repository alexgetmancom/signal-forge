import { expect, test } from "bun:test";
import { memoryReport, sampleMemory } from "../src/runtime/observability.js";
import { openDatabase } from "../src/storage/database.js";

type Sample = { rss: number; kills: number; boot: string; anon?: number | null; container?: number; peak?: number };

const insert = (db: ReturnType<typeof openDatabase>, at: string, sample: Sample) =>
  db
    .query(
      "INSERT INTO memory_samples(sampled_at,boot_id,rss_mb,heap_used_mb,cgroup_current_mb,cgroup_peak_mb,cgroup_limit_mb,oom_kills,anon_mb,file_mb) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      at,
      sample.boot,
      sample.rss,
      sample.rss / 2,
      sample.container ?? sample.rss + 20,
      sample.peak ?? sample.rss + 40,
      2048,
      sample.kills,
      sample.anon === undefined ? sample.rss : sample.anon,
      200,
    );

test("a sample is stored and old ones are dropped", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  insert(db, "2026-05-01T00:00:00.000Z", { rss: 100, kills: 0, boot: "old" });
  sampleMemory(db, now);
  const rows = db.query<{ sampled_at: string }, []>("SELECT sampled_at FROM memory_samples").all();
  expect(rows.map((row) => row.sampled_at)).toEqual(["2026-09-19T12:00:00.000Z"]);
});

test("the report finds the peak, time near the limit, and kills from the counter's rise", () => {
  const db = openDatabase(":memory:");
  insert(db, "2026-09-18T10:00:00.000Z", { rss: 400, kills: 2, boot: "a" });
  insert(db, "2026-09-18T10:05:00.000Z", { rss: 1800, kills: 2, boot: "a" });
  insert(db, "2026-09-18T10:10:00.000Z", { rss: 300, kills: 3, boot: "b" });
  insert(db, "2026-09-19T09:00:00.000Z", { rss: 500, kills: 3, boot: "b" });
  const report = memoryReport(db, 7, Date.parse("2026-09-19T12:00:00.000Z"));
  expect(report.oomKills).toBe(1);
  expect(report.peak).toEqual({ at: "2026-09-18T10:05:00.000Z", rssMb: 1800, anonMb: 1800, containerMb: 1820 });
  expect(report.days).toHaveLength(2);
  const [first] = report.days;
  expect(first).toMatchObject({
    day: "2026-09-18",
    samples: 3,
    maxRssMb: 1800,
    maxAnonMb: 1800,
    samplesAbovePressure: 1,
    oomKills: 1,
    boots: 2,
  });
});

test("a container full of page cache is not pressure, and the kernel's own mark is still reported", () => {
  // The shape of 2026-09-27: 174 MB of anonymous pages, a container at its limit because 472 MB of
  // app.db is in the page cache, and a kernel high-water mark above every sample taken.
  const db = openDatabase(":memory:");
  const cached = { rss: 340, kills: 0, boot: "c", anon: 174, container: 1800, peak: 2020 };
  insert(db, "2026-09-18T10:00:00.000Z", cached);
  insert(db, "2026-09-18T10:05:00.000Z", { ...cached, container: 1700 });
  const [day] = memoryReport(db, 7, Date.parse("2026-09-18T12:00:00.000Z")).days;
  expect(day).toMatchObject({
    maxAnonMb: 174,
    maxContainerMb: 1800,
    peakContainerMb: 2020,
    samplesAbovePressure: 0,
  });
});

test("a sample stored before anon was collected is judged on rss instead", () => {
  const db = openDatabase(":memory:");
  insert(db, "2026-09-18T10:00:00.000Z", { rss: 1900, kills: 0, boot: "d", anon: null });
  const [day] = memoryReport(db, 7, Date.parse("2026-09-18T12:00:00.000Z")).days;
  expect(day).toMatchObject({ maxAnonMb: null, samplesAbovePressure: 1 });
});
