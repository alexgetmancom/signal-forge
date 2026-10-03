import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { indexUses, unexplained } from "../scripts/indexReaders.js";
import { runMigrations } from "../src/storage/migrationRunner.js";

function schema(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  db.exec("ANALYZE");
  return db;
}

test("the index a hot write seeks through is explained by it, not left unread", () => {
  const db = schema();
  const uses = indexUses(db);
  // The whole reason HOT_WRITES exists. Before migration 076 this was
  // `source_collection_metrics_source_time`, 14.1 MB and the largest index in the database, named
  // by nothing because its only caller was an INSERT ... SELECT. Since 076 the key is the table
  // and what stands in its place is `records`' own key, reached only by a write.
  const byWrite = uses.filter((use) => use.hotStatements.some((name) => name.startsWith("write: ")));
  expect(byWrite.length).toBeGreaterThan(0);
  expect(byWrite.map((use) => use.index)).toContain("sqlite_autoindex_records_1");
  db.close();
});

test("a foreign key's referential action counts as a reader", () => {
  const db = schema();
  const use = indexUses(db).find((one) => one.index === "model_fact_fields_event");
  // Nothing in this repository reads model_fact_fields by event_id. `ON DELETE SET NULL` does,
  // every time retention deletes an event, and no plan written here will ever mention it. An
  // exemption list would have carried a guess; pragma_foreign_key_list carries the answer.
  expect(use?.foreignKey).toBe("model_fact_fields.event_id -> events(id)");
  expect(unexplained([use as NonNullable<typeof use>])).toEqual([]);
  db.close();
});

test("a UNIQUE index is a constraint, so it is never asked which read it is for", () => {
  const db = schema();
  const uses = indexUses(db);
  const recap = uses.find((one) => one.index === "batches_recap_period");
  expect(recap?.unique).toBe(true);
  expect(unexplained([recap as NonNullable<typeof recap>])).toEqual([]);
  // An autoindex has no `sql` and exists only because a UNIQUE or a non-INTEGER PRIMARY KEY asked
  // for it, so it is one by definition rather than by its text.
  expect(uses.filter((one) => !one.declared).every((one) => one.unique)).toBe(true);
  db.close();
});

test("an index nothing can explain is reported", () => {
  const db = schema();
  // On a column nothing filters by. The first version of this indexed `events(kind)` and the test
  // failed because the planner reached for it: one hot read filters `kind='new'`, so the new index
  // was explained the moment it existed. A pleasant way to find out the derivation works.
  db.exec("CREATE INDEX records_missing_count ON records(missing_count)");
  const left = unexplained(indexUses(db));
  expect(left.map((one) => one.index)).toContain("records_missing_count");
  db.close();
});
