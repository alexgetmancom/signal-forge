import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { HOT_QUERIES, HOT_WRITES, scansATable } from "../src/storage/hotQueries.js";

test("the reads allowed to scan are the ones that say why", () => {
  const declared = HOT_QUERIES.filter((query) => query.scansByDesign !== undefined);
  expect(declared.map((query) => query.name)).toEqual(["the timings totals, with each name's newest failure"]);
  for (const query of declared) expect(query.scansByDesign?.length).toBeGreaterThan(40);
});

test("a scan is told from a search, including the covering kind", () => {
  expect(scansATable("SCAN events")).toBe(true);
  expect(scansATable("SEARCH events USING INDEX events_detected_at (detected_at>?)")).toBe(false);
  expect(scansATable("SCAN records USING COVERING INDEX records_stream")).toBe(false);
  // Two lines, one of which scans, is a scan: the query still reads a whole table.
  expect(scansATable("SEARCH a USING INDEX i (x=?) | SCAN b")).toBe(true);
});

test("every hot read runs, and every one of them uses an index", () => {
  const db = openDatabase(":memory:");
  // An empty database has no statistics, so the planner chooses on the declared indexes alone --
  // which is the question here: does an index exist that this shape can use at all.
  for (const query of HOT_QUERIES) {
    const plan = db
      .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.params)
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).not.toBe("");
    // A failure here means either an index was removed or a query was written that nothing serves.
    // Both are worth a broken test: an index nobody reads and a read nobody indexed look the same
    // from production, which is exactly what migration 049 demonstrated.
    // A read that scans on purpose says so in its entry, with the reason; everything else must be
    // served by an index that exists.
    expect({ name: query.name, plan, scans: scansATable(plan) }).toEqual({
      name: query.name,
      plan,
      scans: query.scansByDesign !== undefined,
    });
  }
  db.close();
});

test("every hot write runs, and runs against the key it names", () => {
  const db = openDatabase(":memory:");
  for (const write of HOT_WRITES) {
    const plan = db
      .query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${write.sql}`)
      .all(...write.params)
      .map((row) => row.detail)
      .join(" | ");
    // Not every write has a plan. `INSERT ... VALUES ... ON CONFLICT DO UPDATE` searches for
    // nothing: SQLite finds the conflicting row through the key's own b-tree without a step worth
    // reporting, so its plan is empty and that is correct. A write with a FROM or a WHERE has one,
    // and that is the half a migration can take away.
    const searches = /\b(FROM|WHERE)\b/i.test(write.sql.replace(/ON CONFLICT[\s\S]*$/i, ""));
    expect({ name: write.name, planned: plan !== "" }).toEqual({ name: write.name, planned: searches });
    // The reason this list exists at all: the index these statements seek through was 14.1 MB and
    // invisible, because `index-cost` could only look at reads and the only caller was an INSERT.
    expect(write.seeks.length).toBeGreaterThan(20);
  }
  db.close();
});

test("a hot write is executable, not merely plannable", () => {
  const db = openDatabase(":memory:");
  // EXPLAIN never touches a page, so a statement with a typo in a column name plans fine and fails
  // the first time it runs -- which for a write is inside a collection. Each is run for real and
  // rolled back, the same way `rehearse-migration` times them.
  for (const write of HOT_WRITES) {
    db.exec("BEGIN");
    expect(() => db.query(write.sql).all(...write.params)).not.toThrow();
    db.exec("ROLLBACK");
  }
  db.close();
});
