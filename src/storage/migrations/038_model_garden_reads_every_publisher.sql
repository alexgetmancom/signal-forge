-- Model Garden is read for thirteen publishers instead of xAI alone, and its ids now carry the
-- publisher. The six xAI rows stored since 2026-09-17 12:57 produced no event; left in place, the
-- next collection would announce 190 models that were already there, and remove six that were not
-- gone. Forgetting them makes the next collection a silent baseline again. The guard keeps any row
-- that has become evidence since.

DELETE FROM model_fact_fields
WHERE source = 'vertex-model-garden'
  AND NOT EXISTS (SELECT 1 FROM events WHERE source = 'vertex-model-garden');
DELETE FROM model_facts WHERE NOT EXISTS (SELECT 1 FROM model_fact_fields f WHERE f.canonical_id = model_facts.canonical_id);
DELETE FROM records
WHERE source = 'vertex-model-garden'
  AND NOT EXISTS (SELECT 1 FROM events WHERE source = 'vertex-model-garden');
DELETE FROM snapshots
WHERE source = 'vertex-model-garden'
  AND NOT EXISTS (SELECT 1 FROM events WHERE source = 'vertex-model-garden');
UPDATE sources SET last_success = NULL
WHERE id = 'vertex-model-garden'
  AND NOT EXISTS (SELECT 1 FROM events WHERE source = 'vertex-model-garden');
