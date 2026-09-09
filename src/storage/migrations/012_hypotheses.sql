CREATE TABLE hypotheses (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('emerging', 'strengthening', 'confirmed', 'stale')),
  independent_source_count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  formed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_event_id INTEGER REFERENCES events(id)
);

CREATE TABLE hypothesis_events (
  hypothesis_id INTEGER NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  role TEXT NOT NULL CHECK(role IN ('supporting', 'resolution')),
  PRIMARY KEY(hypothesis_id, event_id)
);

CREATE INDEX hypotheses_updated
ON hypotheses(updated_at);

CREATE INDEX hypothesis_events_event
ON hypothesis_events(event_id);
