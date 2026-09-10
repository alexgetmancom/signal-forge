CREATE TABLE alert_attempts (
  id INTEGER PRIMARY KEY,
  state_version INTEGER NOT NULL UNIQUE,
  from_state_json TEXT NOT NULL,
  to_state_json TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX alert_attempts_due ON alert_attempts(status, next_attempt);
