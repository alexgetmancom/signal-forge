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
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('source_collection_metrics','stories','story_events') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "source_collection_metrics" }, { name: "stories" }, { name: "story_events" }]);
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
    expect(db.query("SELECT id,batch_id,status,external_id FROM deliveries ORDER BY id").all()).toEqual([
      { id: 42, batch_id: 7, status: "sent", external_id: "123" },
      { id: 43, batch_id: 7, status: "pending", external_id: null },
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
    expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 2 });
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
