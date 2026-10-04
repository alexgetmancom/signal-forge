-- `output` meant two things, and which one depended on who was talking. OpenRouter and Bedrock
-- write `output: ["text","image"]`, a list of what a model returns; models.dev and Vercel's gateway
-- wrote `output: 128000`, a ceiling on how much of it there can be. Two readers knew that -- the
-- Model Facts projection told them apart by the type of the value, and `servesAnotherModality`
-- refused to read a number as a modality -- and every reader written next had to work it out again.
-- A filter that did not would have called every model on models.dev an image model.
--
-- So the two collectors that wrote a ceiling now write `maxOutputTokens`, and this renames the key
-- in what is already stored. Only those two sources are touched, and only where the value is a
-- number: the rename is of a name, so nothing a reader can see moves. No `amended_records` row is
-- owed, because the collectors write the new key too -- the next collection of these sources finds
-- the body it would have written and produces no event at all. That is the whole reason the stored
-- bodies are rewritten here rather than left to drift: left alone, the next poll would have
-- reported a field leaving and a field arriving on every one of these records at once.
--
-- `rehearse --only migration` will say 2805 records "will tell a reader something no upstream said",
-- which is this migration's whole footprint -- 2,398 models.dev records and 407 of the gateway's --
-- and is a false alarm here, because that verdict reads the migration without the collectors that
-- moved with it. Checked rather than argued, against the live copy: the stored snapshot of each
-- source was parsed by the new collectors and compared with the migrated bodies, and 0 of 2,805
-- differed in any field. A rename on one side only would have been 2,805 cards.
--
-- The events are rewritten for the same reason migration 080 rewrote them: the projections and the
-- cards are read back out of `after_json`, and a history spelled the old way would need every reader
-- to keep both spellings for ever, which is the ambiguity this is removing.
UPDATE records
   SET body = json_remove(json_set(body, '$.maxOutputTokens', json_extract(body, '$.output')), '$.output')
 WHERE source IN ('models-dev', 'vercel-gateway')
   AND json_type(body, '$.output') IN ('integer', 'real');

UPDATE records
   SET candidate_body = json_remove(
         json_set(candidate_body, '$.maxOutputTokens', json_extract(candidate_body, '$.output')),
         '$.output'
       )
 WHERE source IN ('models-dev', 'vercel-gateway')
   AND candidate_body IS NOT NULL
   AND json_type(candidate_body, '$.output') IN ('integer', 'real');

UPDATE events
   SET after_json = json_remove(
         json_set(after_json, '$.maxOutputTokens', json_extract(after_json, '$.output')),
         '$.output'
       )
 WHERE source IN ('models-dev', 'vercel-gateway')
   AND json_type(after_json, '$.output') IN ('integer', 'real');

UPDATE events
   SET before_json = json_remove(
         json_set(before_json, '$.maxOutputTokens', json_extract(before_json, '$.output')),
         '$.output'
       )
 WHERE source IN ('models-dev', 'vercel-gateway')
   AND json_type(before_json, '$.output') IN ('integer', 'real');

-- A null under the old name is the source saying it has no ceiling, which is what the collectors
-- still write, so the key moves there too and nothing is invented where nothing was known.
UPDATE records
   SET body = json_remove(json_set(body, '$.maxOutputTokens', json('null')), '$.output')
 WHERE source IN ('models-dev', 'vercel-gateway') AND json_type(body, '$.output') = 'null';

UPDATE events
   SET after_json = json_remove(json_set(after_json, '$.maxOutputTokens', json('null')), '$.output')
 WHERE source IN ('models-dev', 'vercel-gateway') AND json_type(after_json, '$.output') = 'null';

UPDATE events
   SET before_json = json_remove(json_set(before_json, '$.maxOutputTokens', json('null')), '$.output')
 WHERE source IN ('models-dev', 'vercel-gateway') AND json_type(before_json, '$.output') = 'null';

-- The projection is rebuilt at boot; this keeps a database opened by a tool honest before it runs.
-- The values do not move -- the same number was already stored as `maxOutputTokens` by the reader
-- that told the two meanings apart -- so there is nothing here to delete, only the field name a
-- later read of the events would derive, which is now the same one.
