ALTER TABLE deliveries RENAME TO deliveries_before_verification;

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  body TEXT NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous', 'verification_required')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  confirmation_source TEXT,
  verified_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  last_reconcile_error TEXT,
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
FROM deliveries_before_verification;

DROP TABLE deliveries_before_verification;

CREATE INDEX deliveries_pending ON deliveries(status, next_attempt);
