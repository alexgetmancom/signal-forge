CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  missing_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source, id)
);

CREATE TABLE IF NOT EXISTS change_candidates (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  observations INTEGER NOT NULL,
  PRIMARY KEY(source, id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  stream TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new', 'changed', 'removed')),
  before_json TEXT,
  after_json TEXT,
  detected_at TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id)
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batch_events (
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  PRIMARY KEY(batch_id, event_id)
);

CREATE TABLE IF NOT EXISTS batch_targets (
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  PRIMARY KEY(batch_id, destination_id)
);

-- Delivery batches were introduced after the first event fanout schema. This baseline deliberately
-- keeps the old event_id shape; 003_delivery_batches.sql is the only path that creates the current
-- delivery table, including on a fresh database.
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  body TEXT NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(event_id, destination_id, part)
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fresh_until INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_source ON events(source, id);
