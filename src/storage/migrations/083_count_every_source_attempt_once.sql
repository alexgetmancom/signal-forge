-- Network spending includes watches that skip collection and collectors that throw. The old
-- collection-only totals omitted both and paired measured bytes with unmeasured historical events.
-- Discard those counters and start one daily tally for all attempts, with its own measured cohort.
ALTER TABLE source_collection_metrics DROP COLUMN requests;
ALTER TABLE source_collection_metrics DROP COLUMN bytes_decoded;
ALTER TABLE source_collection_metrics DROP COLUMN bytes_wire;
ALTER TABLE source_collection_metrics DROP COLUMN not_modified;
ALTER TABLE source_collection_days DROP COLUMN requests;
ALTER TABLE source_collection_days DROP COLUMN bytes_decoded;
ALTER TABLE source_collection_days DROP COLUMN bytes_wire;
ALTER TABLE source_collection_days DROP COLUMN not_modified;

CREATE TABLE source_traffic_days (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  body_reads INTEGER NOT NULL,
  bytes_decoded INTEGER NOT NULL,
  bytes_wire INTEGER,
  not_modified INTEGER NOT NULL,
  cache_hits INTEGER NOT NULL,
  records_processed INTEGER NOT NULL,
  events_created INTEGER NOT NULL,
  first_at TEXT NOT NULL CHECK(first_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_at TEXT NOT NULL CHECK(last_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (day, source)
) WITHOUT ROWID;
ANALYZE;
