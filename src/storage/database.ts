import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, last_success TEXT, last_error TEXT, checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, collected_at TEXT NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      source TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, missing_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source,id)
    );
    CREATE TABLE IF NOT EXISTS change_candidates (
      source TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, observations INTEGER NOT NULL,
      PRIMARY KEY(source,id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, stream TEXT NOT NULL, entity_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('new','changed','removed')), before_json TEXT, after_json TEXT,
      detected_at TEXT NOT NULL, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id)
    );
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, digest INTEGER NOT NULL DEFAULT 0,
      ready_at INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS batch_events (
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, url TEXT NOT NULL,
      PRIMARY KEY(batch_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS batch_targets (
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      destination_id TEXT NOT NULL, destination_json TEXT NOT NULL,
      PRIMARY KEY(batch_id,destination_id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), destination_id TEXT NOT NULL,
      destination_json TEXT NOT NULL, body TEXT NOT NULL, part INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','ambiguous')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      external_id TEXT, error TEXT, updated_at INTEGER NOT NULL,
      UNIQUE(batch_id,destination_id,part)
    );
    CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- One plain sentence in front of a large diff. Kept beside the event rather than inside it:
    -- the evidence is what was observed, the sentence is only a reading of it.
    CREATE TABLE IF NOT EXISTS summaries (
      event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    -- Bodies already downloaded, kept so an unchanged page costs a 304 with no body, and an asset
    -- served as immutable costs no request at all.
    CREATE TABLE IF NOT EXISTS http_cache (
      url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT,
      fresh_until INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status,next_attempt);
    CREATE INDEX IF NOT EXISTS events_source ON events(source,id);
  `);
  // A source that keeps failing should be asked less often, not at full speed: hammering an
  // endpoint that is refusing us is how a collector earns a harder refusal.
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(sources)")
      .all()
      .some((column) => column.name === "failures")
  )
    db.run("ALTER TABLE sources ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
  if (
    db
      .query<{ name: string }, []>("PRAGMA table_info(deliveries)")
      .all()
      .some((c) => c.name === "event_id")
  ) {
    db.transaction(() => {
      db.exec(`INSERT INTO batches(id,source,ready_at,sealed)
        SELECT DISTINCT e.id,e.source,0,1 FROM events e JOIN deliveries d ON d.event_id=e.id;
        INSERT INTO batch_events(batch_id,event_id,url) SELECT id,id,'' FROM batches;
        ALTER TABLE deliveries RENAME TO old_deliveries;
        CREATE TABLE deliveries (
          id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), destination_id TEXT NOT NULL,
          destination_json TEXT NOT NULL, body TEXT NOT NULL, part INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','ambiguous')),
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
          external_id TEXT, error TEXT, updated_at INTEGER NOT NULL,
          UNIQUE(batch_id,destination_id,part)
        );
        INSERT INTO deliveries SELECT * FROM old_deliveries;
        DROP TABLE old_deliveries;
        CREATE INDEX deliveries_pending ON deliveries(status,next_attempt);`);
    })();
  }
  return db;
}
