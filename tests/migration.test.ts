import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { runMigrations } from "../src/storage/migrationRunner.js";
import { CURRENT_SCHEMA_VERSION, readMigrations, validateMigrationSequence } from "../src/storage/migrations.js";

test("migration files form one strict journal", () => {
  const migrations = readMigrations();
  expect(migrations.map((migration) => migration.version)).toEqual(
    Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  expect(() => validateMigrationSequence([...migrations, ...migrations.slice(0, 1)])).toThrow(
    "Duplicate migration number",
  );
  expect(() => validateMigrationSequence(migrations.slice(1))).toThrow("gap or wrong order");
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

test("an unversioned current database is adopted without rewriting its data", () => {
  const db = openDatabase(":memory:");
  db.query("INSERT INTO app_state(key,value) VALUES('marker','kept')").run();
  db.exec("PRAGMA user_version=0");
  runMigrations(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(db.query("SELECT value FROM app_state WHERE key='marker'").get()).toEqual({ value: "kept" });
  db.close();
});

test("migration moves legacy summary counters into the usage ledger", () => {
  const db = new Database(":memory:");
  const migrations = readMigrations();
  for (const migration of migrations.slice(0, 14)) db.exec(migration.sql);
  db.query("INSERT INTO app_state(key,value) VALUES('summary_calls_2026-09-08','3')").run();
  db.exec("PRAGMA user_version=14");

  runMigrations(db);

  expect(
    db.query("SELECT operation,model,attempts,input_chars,outcome,cost_basis,attempted_at FROM deepseek_usage").all(),
  ).toEqual([
    {
      operation: "summary.legacy-counter",
      model: "deepseek-v4-flash",
      attempts: 3,
      input_chars: 0,
      outcome: "legacy",
      cost_basis: "unknown",
      attempted_at: "2026-09-08T23:59:59.999Z",
    },
  ]);
  expect(db.query("SELECT value FROM app_state WHERE key='summary_calls_2026-09-08'").get()).toBeNull();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  db.close();
});

test("current-observation migration preserves records and event provenance", () => {
  const db = new Database(":memory:");
  const migrations = readMigrations();
  for (const migration of migrations.slice(0, 16)) db.exec(migration.sql);
  db.exec(`
    INSERT INTO sources(id,last_success) VALUES('openrouter','2026-09-10T00:00:00.000Z');
    INSERT INTO snapshots(id,source,collected_at,raw_json)
      VALUES(1,'openrouter','2026-09-10T00:00:00.000Z','[]');
    INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id)
      VALUES(7,'openrouter','openrouter','openai/gpt-6','new','{"id":"openai/gpt-6"}','2026-09-10T00:00:00.000Z',1);
    INSERT INTO records(source,id,body) VALUES('openrouter','openai/gpt-6','{"id":"openai/gpt-6"}');
    INSERT INTO model_facts(canonical_id,first_seen_at,updated_at)
      VALUES('openai/gpt-6','2026-09-10T00:00:00.000Z','2026-09-10T00:00:00.000Z');
    INSERT INTO model_fact_fields(
      canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at
    ) VALUES(
      'openai/gpt-6','displayName','"GPT-6"','observed','catalogue','openrouter',7,'2026-09-10T00:00:00.000Z'
    ),(
      'openai/gpt-6','availableOnOpenRouter','true','observed','catalogue','openrouter',7,'2026-09-10T00:00:00.000Z'
    );
  `);
  db.exec("PRAGMA user_version=16");

  runMigrations(db);

  expect(db.query("SELECT stream,observed_at FROM records").get()).toEqual({
    stream: "openrouter",
    observed_at: "2026-09-10T00:00:00.000Z",
  });
  expect(db.query("SELECT field,event_id FROM model_fact_fields ORDER BY field").all()).toEqual([
    { field: "availableOnOpenRouter:openrouter", event_id: 7 },
    { field: "displayName", event_id: 7 },
  ]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  db.close();
});

test("schema 9 upgrades to the current projection schema", () => {
  const db = new Database(":memory:");
  const migrations = readMigrations();
  for (const migration of migrations.slice(0, 9)) db.exec(migration.sql);
  db.exec("PRAGMA user_version=9");
  runMigrations(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='model_facts'").get()).toEqual({
    name: "model_facts",
  });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hypotheses'").get()).toEqual({
    name: "hypotheses",
  });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='lifecycle_deadlines'").get()).toEqual({
    name: "lifecycle_deadlines",
  });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("an unversioned delivery-batch database upgrades from the production baseline", () => {
  const db = new Database(":memory:");
  const migrations = readMigrations();
  for (const migration of migrations.slice(0, 2)) db.exec(migration.sql);
  db.exec(`
    INSERT INTO snapshots(id,source,collected_at,raw_json) VALUES(1,'test','2026-09-08','{}');
    INSERT INTO events(id,source,stream,entity_id,kind,after_json,detected_at,snapshot_id)
      VALUES(7,'test','news','x','new','{}','2026-09-08',1);
    INSERT INTO deliveries(id,event_id,destination_id,destination_json,body,part,status,updated_at)
      VALUES(42,7,'tg','{}','already sent',0,'sent',1);
  `);
  const deliveryBatchMigration = migrations[2];
  if (!deliveryBatchMigration) throw new Error("Missing delivery batch migration");
  db.exec(deliveryBatchMigration.sql);
  db.exec("PRAGMA user_version=0");

  runMigrations(db);

  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(db.query("SELECT id,status FROM deliveries").all()).toEqual([{ id: 42, status: "sent" }]);
  expect(db.query("SELECT event_id FROM batch_events").all()).toEqual([{ event_id: 7 }]);
  expect(db.query("SELECT confidence FROM events WHERE id=7").get()).toEqual({ confidence: "observed" });
  expect(db.query("SELECT evidence_type FROM events WHERE id=7").get()).toEqual({ evidence_type: "official_news" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("a failed migration does not advance the schema version", () => {
  const db = new Database(":memory:");
  const first = readMigrations()[0];
  if (!first) throw new Error("Missing initial migration");
  db.exec(first.sql);
  db.exec("PRAGMA user_version=1; ALTER TABLE sources ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;");
  expect(() => runMigrations(db)).toThrow("duplicate column name: failures");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  db.close();
});

test("migration preserves existing delivery IDs, outcomes and event evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "signal-forge-migration-"));
  const path = join(dir, "app.db");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,stream TEXT,entity_id TEXT,kind TEXT,before_json TEXT,after_json TEXT,detected_at TEXT,snapshot_id INTEGER);
    INSERT INTO events VALUES(7,'test','news','x','new',NULL,'{}','2026-09-08',1);
    CREATE TABLE deliveries(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),destination_id TEXT,destination_json TEXT,body TEXT,part INTEGER,status TEXT,attempts INTEGER,next_attempt INTEGER,external_id TEXT,error TEXT,updated_at INTEGER,UNIQUE(event_id,destination_id,part));
    INSERT INTO deliveries VALUES(42,7,'tg','{}','already sent',0,'sent',1,0,'123',NULL,1);
    INSERT INTO deliveries VALUES(43,7,'dc','{}','pending',0,'pending',0,0,NULL,NULL,1);
  `);
  legacy.close();
  try {
    let db = openDatabase(path);
    // A sent delivery is history and survives every migration. A never-attempted pending row
    // addressed by the old stream subscription cannot be routed by signal class, so the signal
    // class migration removes it instead of leaving it to fail at the transport boundary.
    expect(db.query("SELECT id,batch_id,status,external_id FROM deliveries ORDER BY id").all()).toEqual([
      { id: 42, batch_id: 7, status: "sent", external_id: "123" },
    ]);
    expect(db.query("SELECT before_json,after_json FROM events WHERE id=7").all()).toEqual([
      { before_json: null, after_json: "{}" },
    ]);
    expect(db.query("SELECT confidence FROM events WHERE id=7").get()).toEqual({ confidence: "observed" });
    expect(db.query("SELECT evidence_type FROM events WHERE id=7").get()).toEqual({ evidence_type: "official_news" });
    expect(db.query("SELECT event_id FROM batch_events").all()).toEqual([{ event_id: 7 }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    db.close();
    db = openDatabase(path);
    expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 1 });
    expect(db.query("SELECT id,status,external_id FROM deliveries WHERE id=42").get()).toEqual({
      id: 42,
      status: "sent",
      external_id: "123",
    });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
