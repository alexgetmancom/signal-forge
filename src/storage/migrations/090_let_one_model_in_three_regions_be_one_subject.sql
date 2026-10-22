-- One model deprecated once, however many groups of regions AWS lists it under.
--
-- `aws-bedrock-lifecycle` keyed a row by its regions, so the page's grouping was part of the
-- subject's identity: `anthropic.claude-3-haiku-20240307-v1:0` was stored five times, as
-- `...-v1-0-ca-central-1`, `...-v1-0-eu-central-2-sa-east-1` and three more. AWS reshuffles the
-- groups between reads, and every reshuffle was a subject nobody had heard of -- on 2026-10-16 that
-- was six cards for two models inside one minute. The parser now keys the model without its
-- regions and folds the groups into one row that carries all of them; this is the same rename for
-- the 61 records and 48 entity ids already stored, so that history reads as one subject each
-- instead of as five.
--
-- `entity_id` is identity, and these are the three tables that hold it: `records` by its primary
-- key, `events` by the column, and nothing else -- `stories`, `suppressions` and `delivery_events`
-- all point at an event's integer id, and `lifecycle_deadlines` is rebuilt from the events at every
-- boot. Nothing is deleted except a duplicate record row, and no event is touched beyond the name
-- of the subject it is about.
--
-- The new key is computed from each row's own `provider`, `modelId` and `version` rather than from
-- a list written out here, so what this renames is whatever production holds at the moment it runs
-- and not what a copy of it held while this was written. `slug` in src/text.ts is what the
-- recursive expression below reproduces: lowercase, every run of anything else a single dash, no
-- dash at either end.
CREATE TABLE bedrock_key_map (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);

CREATE TABLE bedrock_key_source (
  old_id TEXT PRIMARY KEY,
  key TEXT NOT NULL
);

INSERT INTO bedrock_key_source(old_id, key)
SELECT id,
       json_extract(body, '$.provider') || ':' || json_extract(body, '$.modelId') || ':' ||
       COALESCE(json_extract(body, '$.version'), '')
FROM records
WHERE source = 'aws-bedrock-lifecycle'
  AND json_valid(body)
  AND json_type(body, '$.provider') = 'text'
  AND json_type(body, '$.modelId') = 'text';

INSERT OR IGNORE INTO bedrock_key_source(old_id, key)
SELECT entity_id,
       json_extract(body, '$.provider') || ':' || json_extract(body, '$.modelId') || ':' ||
       COALESCE(json_extract(body, '$.version'), '')
FROM (
  SELECT entity_id, COALESCE(after_json, before_json) AS body, MAX(id) AS newest
  FROM events
  WHERE source = 'aws-bedrock-lifecycle'
  GROUP BY entity_id
)
WHERE json_valid(body)
  AND json_type(body, '$.provider') = 'text'
  AND json_type(body, '$.modelId') = 'text';

INSERT INTO bedrock_key_map(old_id, new_id)
WITH RECURSIVE slugged(old_id, source, position, slug) AS (
  SELECT old_id, lower(key), 1, '' FROM bedrock_key_source
  UNION ALL
  SELECT old_id, source, position + 1,
         CASE
           WHEN substr(source, position, 1) GLOB '[a-z0-9]' THEN slug || substr(source, position, 1)
           WHEN slug <> '' AND substr(slug, -1, 1) <> '-' THEN slug || '-'
           ELSE slug
         END
  FROM slugged WHERE position <= length(source)
)
SELECT old_id, rtrim(slug, '-') FROM slugged
WHERE position = length(source) + 1 AND rtrim(slug, '-') <> '';

-- A row whose key is unchanged is not a rename, and leaving it in the map would make the update
-- below collide with itself.
DELETE FROM bedrock_key_map WHERE old_id = new_id;

-- Where several region groups become one key, the row last observed is the one that stands -- the
-- same choice `folded` makes in the parser, and the one carrying the regions seen most recently.
-- The next collection rewrites its regions to the union of all of them and says so as a change.
DELETE FROM records WHERE source = 'aws-bedrock-lifecycle' AND id IN (
  SELECT m.old_id FROM bedrock_key_map m
  JOIN records r ON r.source = 'aws-bedrock-lifecycle' AND r.id = m.old_id
  WHERE EXISTS (
    SELECT 1 FROM bedrock_key_map other
    JOIN records sibling ON sibling.source = 'aws-bedrock-lifecycle' AND sibling.id = other.old_id
    WHERE other.new_id = m.new_id
      AND other.old_id <> m.old_id
      AND (sibling.observed_at, sibling.id) > (r.observed_at, r.id)
  )
);

-- A row already stored under the new key -- none today, but a boot that reads the page before this
-- runs would leave one -- is the newer sighting, and the old one makes way for it.
DELETE FROM records WHERE source = 'aws-bedrock-lifecycle' AND id IN (
  SELECT m.old_id FROM bedrock_key_map m
  WHERE EXISTS (
    SELECT 1 FROM records held WHERE held.source = 'aws-bedrock-lifecycle' AND held.id = m.new_id
  )
);

UPDATE records
SET id = (SELECT new_id FROM bedrock_key_map WHERE old_id = records.id)
WHERE source = 'aws-bedrock-lifecycle'
  AND id IN (SELECT old_id FROM bedrock_key_map);

UPDATE events
SET entity_id = (SELECT new_id FROM bedrock_key_map WHERE old_id = events.entity_id)
WHERE source = 'aws-bedrock-lifecycle'
  AND entity_id IN (SELECT old_id FROM bedrock_key_map);

DROP TABLE bedrock_key_map;
DROP TABLE bedrock_key_source;
