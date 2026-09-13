import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { CURRENT_SCHEMA_VERSION, readMigrations, validateMigrationSequence } from "../src/storage/migrations.js";

test("migration files form one journal ending at the current version", () => {
  const migrations = readMigrations();
  const baseline = migrations[0];
  if (!baseline) throw new Error("Missing baseline migration");
  expect(migrations[migrations.length - 1]?.version).toBe(CURRENT_SCHEMA_VERSION);
  expect(migrations.map((migration) => migration.version)).toEqual(
    migrations.map((_, index) => baseline.version + index),
  );
  expect(() => validateMigrationSequence([baseline, baseline])).toThrow("Duplicate migration number");
  expect(() => validateMigrationSequence([baseline, { ...baseline, version: baseline.version + 2 }])).toThrow(
    "gap or wrong order",
  );
  expect(() => validateMigrationSequence([])).toThrow("No migrations found");
  // The baseline is numbered for the version it produces, not for being first.
  expect(() => validateMigrationSequence([{ ...baseline, version: 1 }])).toThrow("does not match files");
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

test("a database already at the baseline version is left alone", () => {
  // The case that failed a deployment: production holds the version the baseline produces, so the
  // runner has nothing to do and must not treat that version as newer than the schema it knows.
  const db = openDatabase(":memory:");
  db.query("INSERT INTO app_state(key,value) VALUES('marker','kept')").run();
  expect(() => runMigrations(db)).not.toThrow();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(db.query("SELECT value FROM app_state WHERE key='marker'").get()).toEqual({ value: "kept" });
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
