-- Since when this deployment has been reading a source, as opposed to since when a subject existed.
--
-- Migration 061 gave a story the date its model came out, and `passedOver` used it to count the
-- subjects the world already had while we were still reading about them. On the first week of that
-- number every row in it was an import: DeepSeek V3 at 623 days, Qwen3 30B A3B at 497, MiniMax M2 at
-- 323. Nothing was missed. We started reading the OpenRouter catalogue on 2026-09-09 and it handed
-- us its whole history on the first call, so a model released in 2024 arrived 623 days "late" by an
-- arithmetic that measured from its release to our first sighting and knew nothing about when we
-- first looked.
--
-- Lateness is only ours from the moment a source that could have carried the subject was being read.
-- That instant existed in two places and neither was durable: `source_collection_metrics` keeps 90
-- days of collections and `events` are pruned with their batches, so the answer would have drifted
-- forward as the evidence behind it aged, quietly reclassifying real misses as history.
--
-- So it is stored once, where the source itself is. NULL means we have no record of a first
-- collection -- a source registered and never yet asked -- and a reader treats it as no claim rather
-- than as "since forever": `passedOver` falls back to the release date alone for those, which is the
-- number it used to print for everything.
--
-- The backfill takes the earliest collection or event we still hold for each source, which is the
-- best available answer and is exact for every source this deployment has had since 2026-09-08.

ALTER TABLE sources ADD COLUMN first_observed_at TEXT CHECK(first_observed_at IS NULL OR first_observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z');

WITH watched AS (
  SELECT source, MIN(started) AS started FROM (
    SELECT source AS source, MIN(collected_at) AS started FROM source_collection_metrics GROUP BY source
    UNION ALL
    SELECT source AS source, MIN(detected_at) AS started FROM events GROUP BY source
  ) GROUP BY source
)
UPDATE sources
   SET first_observed_at = (SELECT watched.started FROM watched WHERE watched.source = sources.id)
 WHERE EXISTS (SELECT 1 FROM watched WHERE watched.source = sources.id AND watched.started IS NOT NULL);
