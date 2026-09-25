import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { HOT_QUERIES, scansATable } from "../src/storage/hotQueries.js";

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
    expect({ name: query.name, plan, scans: scansATable(plan) }).toEqual({
      name: query.name,
      plan,
      scans: false,
    });
  }
  db.close();
});
