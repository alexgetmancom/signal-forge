import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { CURRENT_SCHEMA_VERSION, readMigrations, validateMigrationSequence } from "../src/storage/migrations.js";

test("migration files form one strict journal", () => {
  const migrations = readMigrations();
  expect(migrations.map((migration) => migration.version)).toEqual(
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  const first = migrations[0];
  if (!first) throw new Error("Missing initial migration");
  expect(() => validateMigrationSequence([first, first])).toThrow("Duplicate migration number");
  expect(() => validateMigrationSequence([{ ...first, version: 2 }])).toThrow("gap or wrong order");
  expect(() => validateMigrationSequence([])).toThrow("No migrations found");
});

test("fresh databases use every migration and finish with a valid current schema", () => {
  const db = openDatabase(":memory:");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(sources)")
      .all()
      .map((column: { name: string }) => column.name),
  ).toContain("failures");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(deliveries)")
      .all()
      .map((column: { name: string }) => column.name),
  ).toContain("batch_id");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(deliveries)")
      .all()
      .map((column: { name: string }) => column.name),
  ).not.toContain("event_id");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(events)")
      .all()
      .map((column: { name: string }) => column.name),
  ).toContain("confidence");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(events)")
      .all()
      .map((column: { name: string }) => column.name),
  ).toContain("authority");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(records)")
      .all()
      .map((column) => column.name),
  ).toEqual(["source", "id", "body", "missing_count", "stream", "observed_at"]);
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('alert_attempts','code_metrics','deepseek_usage','source_collection_metrics','stories','story_events','model_facts','model_fact_fields','model_fact_conflicts','hypotheses','hypothesis_events','lifecycle_deadlines','lifecycle_reminders') ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: "alert_attempts" },
    { name: "code_metrics" },
    { name: "deepseek_usage" },
    { name: "hypotheses" },
    { name: "hypothesis_events" },
    { name: "lifecycle_deadlines" },
    { name: "lifecycle_reminders" },
    { name: "model_fact_conflicts" },
    { name: "model_fact_fields" },
    { name: "model_facts" },
    { name: "source_collection_metrics" },
    { name: "stories" },
    { name: "story_events" },
  ]);
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(batches)")
      .all()
      .map((column) => column.name),
  ).toEqual(["id", "source", "digest", "ready_at", "sealed", "kind", "context_json"]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("a failed migration does not advance the schema version", () => {
  const db = new Database(":memory:");
  // A table the schema also creates: migration 001 fails partway, and the stamp it would have
  // written has to fail with it.
  db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY)");
  expect(() => runMigrations(db)).toThrow("table sources already exists");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  db.close();
});
