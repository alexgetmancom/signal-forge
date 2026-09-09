CREATE TABLE source_collection_metrics (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  records_processed INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  changed_events INTEGER NOT NULL DEFAULT 0,
  removed_events INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX source_collection_metrics_source_time ON source_collection_metrics(source, collected_at);
