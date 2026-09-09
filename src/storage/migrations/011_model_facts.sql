CREATE TABLE model_facts (
  canonical_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_fact_fields (
  canonical_id TEXT NOT NULL REFERENCES model_facts(canonical_id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  evidence_type TEXT NOT NULL,
  source TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(canonical_id, field)
);

CREATE TABLE model_fact_conflicts (
  canonical_id TEXT NOT NULL,
  field TEXT NOT NULL,
  incumbent_event_id INTEGER NOT NULL REFERENCES events(id),
  challenger_event_id INTEGER NOT NULL REFERENCES events(id),
  detected_at TEXT NOT NULL,
  PRIMARY KEY(canonical_id, field, incumbent_event_id, challenger_event_id)
);

CREATE INDEX model_facts_updated
ON model_facts(updated_at);

CREATE INDEX model_fact_fields_event
ON model_fact_fields(event_id);
