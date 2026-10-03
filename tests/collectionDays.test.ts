import { expect, test } from "bun:test";
import { addCollectionToDay, addPeakToDay, foldCollectionDays } from "../src/storage/collectionDays.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * The hot path adds one collection to its day; the cycle discards the day and rebuilds it from the
 * raw attempts. These are two implementations of the same arithmetic, and the only thing that makes
 * the cheap one safe is that it agrees with the expensive one. So that is what is asserted here,
 * over a day built one attempt at a time rather than over a hand-written expectation.
 */
const rows = (db: ReturnType<typeof openDatabase>) =>
  db
    .query<Record<string, unknown>, []>("SELECT * FROM source_collection_days ORDER BY day, source, outcome")
    .all()
    .map((row) => JSON.stringify(row));

/** One raw attempt, without the fixture's fold, so the increment is the only writer. */
function attempt(
  db: ReturnType<typeof openDatabase>,
  source: string,
  at: string,
  outcome: { error: string; kind?: string | null } | null,
  measured: { peakRssMb?: number; records?: number; events?: number; changed?: number } = {},
): void {
  db.query(
    `INSERT INTO source_collection_metrics(
       source,collected_at,success,error,failure_kind,peak_rss_mb,records_processed,events_created,changed_events
     ) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    source,
    at,
    outcome ? 0 : 1,
    outcome?.error ?? null,
    outcome?.kind ?? null,
    measured.peakRssMb ?? null,
    measured.records ?? 0,
    measured.events ?? 0,
    measured.changed ?? 0,
  );
  addCollectionToDay(db, source, at);
}

const day = (hour: number, minute = 0) =>
  `2026-09-27T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

test("a day built one collection at a time is the day the fold computes", () => {
  const db = openDatabase(":memory:");
  attempt(db, "polymarket", day(1), null, { records: 4, events: 2, changed: 1 });
  attempt(db, "polymarket", day(2), null, { records: 6, events: 1, changed: 1 });
  attempt(db, "polymarket", day(3), { error: "boom", kind: "network" });
  attempt(db, "polymarket", day(4), { error: "boom", kind: "network" });
  attempt(db, "deepinfra", day(5), null, { records: 1 });
  // A kind that was never recorded, and a guard refusal, so `FAILURE_KIND`'s own branches are the
  // ones being compared rather than only the column.
  attempt(db, "deepinfra", day(6), { error: "Collection degraded: half the roster vanished" });
  attempt(db, "deepinfra", day(7), { error: "something older than kinds" });

  const incremental = rows(db);
  expect(incremental).toHaveLength(5);
  foldCollectionDays(db, Date.parse(day(23)), 2);
  expect(rows(db)).toEqual(incremental);
});

test("the peak the poller stamps after the commit reaches the day, and matches the fold", () => {
  const db = openDatabase(":memory:");
  // Three successes, two of which ran in a child process that reported its own high-water mark.
  attempt(db, "polymarket", day(1), null);
  db.query("UPDATE source_collection_metrics SET peak_rss_mb=? WHERE source=? AND collected_at=?").run(
    417,
    "polymarket",
    day(1),
  );
  addPeakToDay(db, "polymarket", day(1), 417);
  attempt(db, "polymarket", day(2), null);
  db.query("UPDATE source_collection_metrics SET peak_rss_mb=? WHERE source=? AND collected_at=?").run(
    317,
    "polymarket",
    day(2),
  );
  addPeakToDay(db, "polymarket", day(2), 317);
  attempt(db, "polymarket", day(3), null);

  const incremental = rows(db);
  const row = db
    .query<{ max: number; total: number; samples: number; attempts: number }, []>(
      "SELECT peak_rss_max max, peak_rss_total total, peak_rss_samples samples, attempts FROM source_collection_days",
    )
    .get();
  // The worst run, the sum for the average's numerator, and a denominator that counts the runs that
  // reported one -- not the three attempts, which is the mean-of-means the fold refuses to compute.
  expect(row).toEqual({ max: 417, total: 734, samples: 2, attempts: 3 });
  foldCollectionDays(db, Date.parse(day(23)), 2);
  expect(rows(db)).toEqual(incremental);
});

test("a repair corrects an increment that never happened, rather than adding to it", () => {
  const db = openDatabase(":memory:");
  attempt(db, "polymarket", day(1), null, { records: 3 });
  // A crash between the raw insert and the increment: the attempt is evidence, the day is short.
  db.query("INSERT INTO source_collection_metrics(source,collected_at,success,records_processed) VALUES(?,?,1,?)").run(
    "polymarket",
    day(2),
    5,
  );
  expect(db.query<{ attempts: number }, []>("SELECT attempts FROM source_collection_days").get()?.attempts).toBe(1);
  foldCollectionDays(db, Date.parse(day(23)), 2);
  const repaired = db
    .query<{ attempts: number; records: number }, []>(
      "SELECT attempts, records_processed records FROM source_collection_days",
    )
    .get();
  expect(repaired).toEqual({ attempts: 2, records: 8 });
});

test("a day the increment already wrote is not counted twice by the repair", () => {
  const db = openDatabase(":memory:");
  attempt(db, "polymarket", day(1), null, { records: 3 });
  const once = rows(db);
  foldCollectionDays(db, Date.parse(day(23)), 2);
  foldCollectionDays(db, Date.parse(day(23)), 2);
  expect(rows(db)).toEqual(once);
});
