CREATE TABLE lifecycle_deadlines (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  canonical_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  deadline_type TEXT NOT NULL CHECK(deadline_type IN ('deprecation', 'retirement', 'shutdown')),
  deadline_at TEXT NOT NULL,
  replacement TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE lifecycle_reminders (
  deadline_id INTEGER NOT NULL REFERENCES lifecycle_deadlines(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  batch_id INTEGER REFERENCES batches(id),
  PRIMARY KEY(deadline_id, offset_days)
);

CREATE INDEX lifecycle_deadlines_time
ON lifecycle_deadlines(deadline_at);

CREATE INDEX lifecycle_reminders_due
ON lifecycle_reminders(due_at);

ALTER TABLE batches
ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'
CHECK(kind IN ('event', 'lifecycle_reminder'));

ALTER TABLE batches
ADD COLUMN context_json TEXT;
