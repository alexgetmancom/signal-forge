import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import {
  CURRENT_SCHEMA_VERSION,
  readMigrations,
  splitStatements,
  validateMigrationSequence,
} from "../src/storage/migrations.js";

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
  ).toEqual(["source", "id", "body", "missing_count", "stream", "observed_at", "candidate_body"]);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='change_candidates'").all()).toEqual([]);
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

test("a migration is split into statements, and a trigger body keeps its own semicolons", () => {
  expect(splitStatements("CREATE TABLE a(x TEXT);\nCREATE TABLE b(y TEXT);")).toEqual([
    "CREATE TABLE a(x TEXT)",
    "CREATE TABLE b(y TEXT)",
  ]);
  // A semicolon inside a string, inside a comment, and inside a trigger body is not a terminator.
  expect(splitStatements("INSERT INTO a VALUES('one;two');")).toEqual(["INSERT INTO a VALUES('one;two')"]);
  // An escaped quote keeps both halves, and does not end the string it sits in.
  expect(splitStatements("INSERT INTO a VALUES('it''s here;');")).toEqual(["INSERT INTO a VALUES('it''s here;')"]);
  expect(splitStatements("-- a comment; with a semicolon\nCREATE TABLE a(x TEXT);")).toHaveLength(1);
  expect(
    splitStatements(
      "CREATE TRIGGER t BEFORE INSERT ON a\nBEGIN SELECT RAISE(ABORT, 'no'); END;\nCREATE TABLE b(y TEXT);",
    ),
  ).toHaveLength(2);
  // Trailing comments are text, not a statement to run.
  expect(splitStatements("CREATE TABLE a(x TEXT);\n-- nothing after this")).toHaveLength(1);
});

test("a statement that fails a constraint mid-migration rolls the whole migration back", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE old_rows(id INTEGER PRIMARY KEY, at TEXT)");
  db.exec("INSERT INTO old_rows VALUES(1,'not an instant')");
  // The shape a table rebuild has: copy into the replacement, then drop the original. Handing all
  // of it to one exec() would skip the refused copy, drop the original anyway and report success.
  const rebuild = `CREATE TABLE new_rows(id INTEGER PRIMARY KEY, at TEXT NOT NULL CHECK(at GLOB '[0-9]*Z'));
INSERT INTO new_rows SELECT id,at FROM old_rows;
DROP TABLE old_rows;`;
  expect(() =>
    db.transaction(() => {
      for (const statement of splitStatements(rebuild)) db.run(statement);
    })(),
  ).toThrow(/CHECK constraint failed/);
  expect(db.query("SELECT count(*) AS n FROM old_rows").get()).toEqual({ n: 1 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='new_rows'").all()).toEqual([]);
  db.close();
});
