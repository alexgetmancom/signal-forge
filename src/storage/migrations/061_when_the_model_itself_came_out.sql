-- The date the model came out, as opposed to the date we first read about it.
--
-- `first_seen_at` is when this deployment noticed a subject, and nothing anywhere said when the
-- subject actually happened. The two were read as one, and every report built on `stories` inherited
-- the confusion: on 2026-09-27 the misses report headlined Gemini 3.8 Flash and GLM 5.2 Fast as the
-- week's two worst misses, three unrelated sources each and no reader ever told. Google shipped
-- Gemini 3.8 Flash on 2 September and Z.ai shipped GLM 5.2 Fast on 23 June. Nobody was waiting for
-- either. Answering that took a human with a search engine, which is the gap this closes.
--
-- The data was already here. OpenRouter, Hugging Face and the catalogues that copy them write the
-- model's own date on the row, and `worth.ts` has read it since migration 049 -- at event time, for
-- one veto, and then thrown it away. Keeping it on the story is what lets a report ask "was anyone
-- waiting for this" without re-reading bodies it no longer holds.
--
-- NULL is the honest answer for most rows and is not a gap: a repository, a leaderboard move, a
-- Hacker News thread and a status page have no release date to carry, and a model whose catalogues
-- simply never wrote one is unknown rather than new. Readers of this column treat NULL as "no claim"
-- and must not read it as "released today" -- `passedOver` is the worked example.
--
-- The backfill reads the same fields the code reads, in the two shapes catalogues write them: an
-- ISO string, and an epoch that is seconds below 1e11 and milliseconds above it. It takes the
-- earliest such date any event of the story carried, because a model is released once and the later
-- mentions are catalogues catching up. Rows the backfill cannot date stay NULL and are filled by the
-- projection the next time the story moves.

ALTER TABLE stories ADD COLUMN released_at TEXT CHECK(released_at IS NULL OR released_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z');

WITH dated AS (
  SELECT se.story_id AS story_id,
         MIN(
           CASE
             WHEN json_valid(e.after_json) IS NOT 1 THEN NULL
             WHEN json_type(e.after_json, '$.' || f.field) = 'text'
               THEN nullif(strftime('%Y-%m-%dT%H:%M:%S.000Z', json_extract(e.after_json, '$.' || f.field)), '')
             WHEN json_type(e.after_json, '$.' || f.field) IN ('integer', 'real')
               THEN strftime(
                      '%Y-%m-%dT%H:%M:%S.000Z',
                      CAST(json_extract(e.after_json, '$.' || f.field)
                           / CASE WHEN json_extract(e.after_json, '$.' || f.field) > 1e11 THEN 1000 ELSE 1 END
                           AS INTEGER),
                      'unixepoch')
             ELSE NULL
           END
         ) AS released_at
    FROM story_events se
    JOIN events e ON e.id = se.event_id
    JOIN (SELECT 'created' AS field UNION ALL SELECT 'createdAt' UNION ALL SELECT 'created_at'
          UNION ALL SELECT 'releaseDate' UNION ALL SELECT 'release_date') f
   GROUP BY se.story_id
)
UPDATE stories
   SET released_at = (SELECT dated.released_at FROM dated WHERE dated.story_id = stories.id)
 WHERE EXISTS (SELECT 1 FROM dated WHERE dated.story_id = stories.id AND dated.released_at >= '2015-01-01');

-- A date before 2015 is a catalogue's placeholder, not a release: some write `created: 1`.
UPDATE stories SET released_at = NULL WHERE released_at IS NOT NULL AND released_at < '2015-01-01';

-- `passedOver` and `stories` both order and filter on this column beside `updated_at`, and 049
-- shipped five indexes the planner ignored until the statistics existed.
CREATE INDEX stories_released ON stories(released_at);

ANALYZE;
