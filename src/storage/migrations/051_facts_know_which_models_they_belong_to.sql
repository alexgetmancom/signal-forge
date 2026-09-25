-- A fact belongs to a model, and until now nothing wrote down which.
--
-- `rebuildModelFacts` ran on every collection that produced an event and rebuilt all of it: 11,159
-- story events joined and re-identified, 25,000 records re-identified, 4,667 facts and 23,480
-- fields deleted and reinserted, to account for one new event. Measured on production over five
-- days it averaged 1,343 ms and peaked at 11,750 ms, growing 1,122 -> 1,576 ms as history grew,
-- because the cost is the whole history and the history only gets longer.
--
-- It is synchronous and it ran inside the write transaction, which is how it stopped being only a
-- performance question. A rebuild holds the event loop, and a held event loop does not service the
-- sockets waiting on it: `vercel-gateway` failed 204 of 235 collections with TimeoutError and
-- `status:anthropic` 90 of 148, on upstreams that were answering perfectly. Cutting the spikes on
-- 2026-09-24 took those to 1 of 164 and 0 of 57 without touching either collector. The rebuild was
-- losing collections from unrelated sources.
--
-- Everything in the projection partitions by model identity, so the work for one model never needs
-- another model's evidence. What was missing was the way back: given a changed story or record,
-- which model does it belong to. That is this table, and with it a collection recomputes the models
-- it actually touched.

ALTER TABLE model_facts ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS model_facts_key ON model_facts(canonical_key);

-- The way back from a story or a record to the model it was counted under. `kind`+`ref` is the
-- member, and it belongs to exactly one model at a time; a member that moves to another identity
-- makes both the old and the new model dirty, which is why the old key has to be readable.
CREATE TABLE IF NOT EXISTS model_fact_members (
  kind TEXT NOT NULL CHECK(kind IN ('story', 'record')),
  ref TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS model_fact_members_key ON model_fact_members(canonical_key);

-- The rows already stored carry no key and no membership. Rather than guess at either, they are
-- cleared: the service rebuilds Model Facts in full at startup, so the first boot after this
-- migration fills both correctly from the evidence, which is the only source that can.
DELETE FROM model_fact_conflicts;
DELETE FROM model_fact_fields;
DELETE FROM model_facts;

ANALYZE;
