-- `records.observed_at` is overwritten by every collection that still sees the record, so it says
-- when we last confirmed a thing exists, never when we first met it. Two readers wanted the second
-- meaning and got the first: `model_facts.first_seen_at` for a model carried only by records, and
-- the age of an OpenAI price with no catalogue entry. Both reported a model known for a month as
-- minutes old, and `model_facts` is rebuilt from scratch, so the answer drifted forward every run.
--
-- A first sighting has to be written once and then left alone, which is what `sources`
-- already does with `first_observed_at`. The backfill is the earliest event about the record where
-- there is one -- an event is stamped once and kept -- and `observed_at` where there is not, which
-- is the best this column can say about a record that predates it.
ALTER TABLE records ADD COLUMN first_seen_at TEXT CHECK(first_seen_at IS NULL OR first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z');

UPDATE records SET first_seen_at = COALESCE(
  (SELECT MIN(e.detected_at) FROM events e WHERE e.source = records.source AND e.entity_id = records.id),
  observed_at
);
ANALYZE;
