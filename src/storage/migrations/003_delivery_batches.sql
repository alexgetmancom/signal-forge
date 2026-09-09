INSERT OR IGNORE INTO batches(id, source, ready_at, sealed)
SELECT DISTINCT events.id, events.source, 0, 1
FROM events
JOIN deliveries ON deliveries.event_id = events.id;

INSERT OR IGNORE INTO batch_events(batch_id, event_id, url)
SELECT id, id, ''
FROM batches;

ALTER TABLE deliveries RENAME TO deliveries_legacy;

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
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
  UNIQUE(batch_id, destination_id, part)
);

INSERT INTO deliveries(
  id,
  batch_id,
  destination_id,
  destination_json,
  body,
  part,
  status,
  attempts,
  next_attempt,
  external_id,
  error,
  updated_at
)
SELECT
  id,
  event_id,
  destination_id,
  destination_json,
  body,
  part,
  status,
  attempts,
  next_attempt,
  external_id,
  error,
  updated_at
FROM deliveries_legacy;

DROP TABLE deliveries_legacy;

CREATE INDEX deliveries_pending ON deliveries(status, next_attempt);
