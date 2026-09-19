-- A second chance for an answer that said nothing, and never for one that said something.
--
-- Every summary attempt is claimed in deepseek_usage before the request, so a provider failure
-- cannot become a paid retry loop. One unique index on event_id enforced that, and enforced it
-- against the outcome as well: of 200 attempts in the first eleven days, 90 ended 'unclear',
-- 'invalid' or 'failed', and each of those events lost its only chance at a sentence because the
-- claim it had already spent was the one the selection query looked for.
--
-- The claim stays, the ceiling stays, and the count moves into the row: attempt 1, and attempt 2
-- only where the first said nothing usable. CHECK keeps the ceiling in the schema rather than only
-- in the caller, so no code path can spend a third.

ALTER TABLE deepseek_usage ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 2);

DROP INDEX deepseek_usage_event;
CREATE UNIQUE INDEX deepseek_usage_event ON deepseek_usage(event_id, attempt) WHERE event_id IS NOT NULL;
