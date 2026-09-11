-- An event that never became a message left no trace of why. Answering "the digest was empty,
-- what happened?" meant replaying stored events by hand against every threshold. The decision is
-- now written down next to the batch that made it: one row per event and destination, replaced
-- while the batch is still open and deleted the moment the event does speak.
CREATE TABLE suppressions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  destination_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (event_id, destination_id)
);

CREATE INDEX suppressions_recorded_at ON suppressions(recorded_at);
CREATE INDEX suppressions_reason ON suppressions(reason, recorded_at);
