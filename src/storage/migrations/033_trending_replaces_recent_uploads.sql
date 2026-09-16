-- Hugging Face discovery reads the trending list instead of every upload, and ModelScope is no
-- longer collected.
--
-- The upload sweep left 21,562 events on production by 2026-09-16, none of them ever batched, with
-- 21,662 records, a story each and 70,209 Model Facts fields describing quantisations and
-- fine-tunes as models. None of it is evidence anything was told from, so it goes rather than
-- waiting thirty days for retention. The trending source starts under a new id, which is what keeps
-- its first collection a silent baseline instead of a hundred arrivals.
--
-- ModelScope produced two first sightings in the week to 2026-09-16 and no lead over any other
-- source. Its three events were delivered, so they stay; only what would keep it looking like a
-- live source goes.

DELETE FROM model_fact_fields WHERE source = 'discovery:huggingface-recent';
DELETE FROM model_fact_conflicts
WHERE incumbent_event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent')
   OR challenger_event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
DELETE FROM hypothesis_events
WHERE event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
DELETE FROM suppressions
WHERE event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
-- Foreign keys are off while a migration runs, so nothing below cascades on its own.
DELETE FROM story_events
WHERE event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
DELETE FROM summaries
WHERE event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
UPDATE deepseek_usage SET event_id = NULL
WHERE event_id IN (SELECT id FROM events WHERE source = 'discovery:huggingface-recent');
DELETE FROM events
WHERE source = 'discovery:huggingface-recent'
  AND NOT EXISTS (SELECT 1 FROM batch_events be WHERE be.event_id = events.id);
DELETE FROM stories WHERE NOT EXISTS (SELECT 1 FROM story_events se WHERE se.story_id = stories.id);
DELETE FROM model_facts WHERE NOT EXISTS (SELECT 1 FROM model_fact_fields f WHERE f.canonical_id = model_facts.canonical_id);

DELETE FROM records WHERE source IN ('discovery:huggingface-recent', 'modelscope:recent');
DELETE FROM snapshots
WHERE source IN ('discovery:huggingface-recent', 'modelscope:recent')
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.snapshot_id = snapshots.id);
DELETE FROM source_collection_metrics WHERE source IN ('discovery:huggingface-recent', 'modelscope:recent');
DELETE FROM sources WHERE id IN ('discovery:huggingface-recent', 'modelscope:recent');
