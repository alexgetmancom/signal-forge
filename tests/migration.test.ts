import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { applyMigrations, runMigrations } from "../src/storage/migrationRunner.js";
import {
  CURRENT_SCHEMA_VERSION,
  readMigrations,
  splitStatements,
  validateMigrationSequence,
} from "../src/storage/migrations.js";
import { anEvent, aRecord, aSnapshot } from "./fixtures/build.js";

test("compressing the cache discards old cache entries and preserves event evidence", () => {
  const db = new Database(":memory:", { strict: true });
  applyMigrations(
    db,
    readMigrations().filter((migration) => migration.version < 72),
  );
  const event = anEvent(db, { afterJson: '{"name":"Model"}' });
  const evidence = db.query("SELECT * FROM events WHERE id=?").get(event);
  db.query("INSERT INTO http_cache(url,body,used_at) VALUES(?,?,?)").run(
    "https://example.test/page",
    "old cached text",
    "2026-10-01T10:00:00.000Z",
  );

  runMigrations(db);

  expect(db.query("SELECT COUNT(*) n FROM http_cache").get()).toEqual({ n: 0 });
  expect(db.query("SELECT * FROM events WHERE id=?").get(event)).toEqual(evidence);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const cache = new HttpCache(db);
  const entry = { body: "new cached text", etag: '"new"', lastModified: null, freshUntil: 0 };
  cache.put("https://example.test/page", entry);
  expect(cache.get("https://example.test/page")).toEqual(entry);
  expect(db.query("SELECT typeof(body) kind FROM http_cache").get()).toEqual({ kind: "blob" });
  db.close();
});

test("unverified Hugging Face access is forgotten without erasing repositories or their upstream evidence", () => {
  const db = new Database(":memory:", { strict: true });
  applyMigrations(
    db,
    readMigrations().filter((migration) => migration.version < 80),
  );
  const before = { id: "meta-llama/old-model", name: "Old Model", access: "public", created: "2026-09-20T00:00:00Z" };
  const after = { ...before, likes: 10 };
  const snapshotId = aSnapshot(db, { source: "huggingface:meta-llama", body: JSON.stringify([{ id: before.id }]) });
  const event = anEvent(db, {
    source: "huggingface:meta-llama",
    stream: "weights",
    kind: "changed",
    entityId: before.id,
    beforeJson: JSON.stringify(before),
    afterJson: JSON.stringify(after),
    snapshotId,
  });
  const otherEvent = anEvent(db, { source: "other-source", afterJson: JSON.stringify(after) });
  const gatedEvent = anEvent(db, {
    source: "huggingface:meta-llama",
    afterJson: JSON.stringify({ ...after, access: "gated" }),
  });
  const untouchedEvents = db.query("SELECT * FROM events WHERE id IN (?,?) ORDER BY id").all(otherEvent, gatedEvent);
  const snapshot = db.query("SELECT * FROM snapshots WHERE id=?").get(snapshotId);
  aRecord(db, { source: "huggingface:meta-llama", id: before.id, body: after, stream: "weights" });
  aRecord(db, {
    source: "huggingface:meta-llama",
    id: "verified-gated",
    body: { id: "verified-gated", access: "gated" },
    stream: "weights",
  });
  aRecord(db, { source: "other-source", id: before.id, body: after, stream: "weights" });
  db.query(
    "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,'2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z')",
  ).run(before.id);
  const insertFact = db.query(
    "INSERT INTO model_fact_fields(canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at) VALUES(?,?,'\"public\"','supported','open_weights',?,?, '2026-09-20T00:00:00.000Z')",
  );
  insertFact.run(before.id, "access:huggingface:meta-llama", "huggingface:meta-llama", event);
  insertFact.run(before.id, "access:other-source", "other-source", otherEvent);

  runMigrations(db);

  const held = db.query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?");
  const expected = { id: before.id, name: before.name, created: before.created, likes: 10 };
  expect(JSON.parse(held.get("huggingface:meta-llama", before.id)?.body ?? "null")).toEqual(expected);
  expect(JSON.parse(held.get("huggingface:meta-llama", "verified-gated")?.body ?? "null").access).toBe("gated");
  expect(JSON.parse(held.get("other-source", before.id)?.body ?? "null")).toEqual(after);
  const repaired = db
    .query<{ before_json: string; after_json: string; snapshot_id: number }, [number]>(
      "SELECT before_json,after_json,snapshot_id FROM events WHERE id=?",
    )
    .get(event);
  if (!repaired) throw new Error("The migrated event disappeared");
  expect(JSON.parse(repaired.before_json)).toEqual({ id: before.id, name: before.name, created: before.created });
  expect(JSON.parse(repaired.after_json)).toEqual(expected);
  expect(repaired.snapshot_id).toBe(snapshotId);
  expect(db.query("SELECT * FROM events WHERE id IN (?,?) ORDER BY id").all(otherEvent, gatedEvent)).toEqual(
    untouchedEvents,
  );
  expect(db.query("SELECT * FROM snapshots WHERE id=?").get(snapshotId)).toEqual(snapshot);
  expect(db.query("SELECT source,value_json FROM model_fact_fields").all()).toEqual([
    { source: "other-source", value_json: '"public"' },
  ]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

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

test("a fresh database runs the journal and finishes with a valid current schema", () => {
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

test("a database stamped below the baseline is refused by name, and left as it was", () => {
  // An archive from before the squash has no path forward through a file that creates every table.
  // Without the guard it fails on the first CREATE TABLE as if the migration were broken.
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY); PRAGMA user_version = 40");
  expect(() => runMigrations(db)).toThrow("older than the baseline");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "sources" }]);
  db.close();
});

test("a rebuilt table leaves nothing pointing at the name it was rebuilt from", () => {
  // A rename is only a rename while legacy_alter_table says so. Without it, SQLite rewrites the
  // REFERENCES clauses of child tables to the temporary name the migration is about to drop, and
  // the schema survives the migration only to fail on the first insert. It did that on 3.53 and
  // not on 3.51, so the version that finds it is whichever one CI happens to run.
  const db = openDatabase(":memory:");
  const names = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((table) => table.name),
  );
  const dangling = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, COALESCE(sql,'') AS sql FROM sqlite_master WHERE sql LIKE '%REFERENCES%'",
    )
    .all()
    .flatMap((object) =>
      [...object.sql.matchAll(/REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/g)]
        .map((match) => match[1] ?? "")
        .filter((target) => !names.has(target))
        .map((target) => `${object.name} -> ${target}`),
    );
  expect(dangling).toEqual([]);
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
