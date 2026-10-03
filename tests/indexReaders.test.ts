import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { indexUses, redundantPrefixes, unexplained } from "../scripts/indexReaders.js";
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

test("the schema has no index whose columns lead another's, which is what makes the check a ratchet", () => {
  const db = schema();
  // Zero out of 61, checked before the rule was written rather than after. Both pairs this session
  // found by hand are gone: `source_collection_metrics_source_time` against `_failures` on the same
  // two columns went in 076, when the key became the table, and `snapshots_collected` against
  // `snapshots_unexpired` on the same one went in 077. So the check ships with no exemption list,
  // and this test is the thing that keeps it that way.
  expect(redundantPrefixes(indexUses(db))).toEqual([]);
  db.close();
});

test("an index whose columns lead another's on the same table is reported as a pair", () => {
  const db = schema();
  // `snapshots_unexpired` is `(collected_at) WHERE body IS NOT NULL`. An index on `(collected_at)`
  // for every row leads it, which is exactly the shape 077 deleted.
  db.exec("CREATE INDEX snapshots_collected_again ON snapshots(collected_at)");
  const pairs = redundantPrefixes(indexUses(db));
  const pair = pairs.find((one) => [one.prefix.index, one.covering.index].includes("snapshots_collected_again"));
  expect(pair).toBeDefined();
  expect(pair?.table).toBe("snapshots");
  // The pair is reported, not a victim: which of the two to drop is about bytes, and for the 14.1
  // MB pair the answer turned out to be neither -- 076 made the key the table instead.
  expect([pair?.prefix.index, pair?.covering.index].sort()).toEqual(
    ["snapshots_collected_again", "snapshots_unexpired"].sort(),
  );
  // And the partial one is named as partial, because that is the reason a pair can be legitimate.
  expect(pairs.some((one) => one.prefix.partial !== null || one.covering.partial !== null)).toBe(true);
  db.close();
});

test("a UNIQUE prefix is a stronger constraint, not a duplicate, so the pair is not reported", () => {
  const db = schema();
  db.exec("CREATE TABLE pair_probe (a TEXT, b TEXT)");
  db.exec("CREATE UNIQUE INDEX pair_probe_a ON pair_probe(a)");
  db.exec("CREATE INDEX pair_probe_ab ON pair_probe(a, b)");
  // Nothing is reported, and both halves of that are deliberate. `(a)` leads `(a, b)` but is
  // UNIQUE, so it is a constraint rather than a cost -- dropping it changes what the database
  // accepts. And `(a, b)` does not lead `(a)`, so it is never the prefix. It is arguably the
  // wasteful one, since `a` being unique means `b` can never narrow a seek further, but that
  // argument is about covering reads and this check does not make it. Reporting a pair it cannot
  // justify is how a ratchet acquires its first exemption.
  expect(redundantPrefixes(indexUses(db)).filter((one) => one.table === "pair_probe")).toEqual([]);
  db.close();
});
