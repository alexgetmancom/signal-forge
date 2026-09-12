-- When the outage began, kept apart from when it was last observed.
--
-- `checked_at` is the most recent poll, so an issue derived from it reported that a source which
-- has never once succeeded first failed a moment ago, and said so again every five minutes. The
-- duration a reader and an operator both want is the distance from the first failure in the current
-- run, not from the latest confirmation of it.
--
-- Existing rows are seeded from checked_at where a source is currently failing: it is the earliest
-- moment the database can still prove, and it only ever understates the outage.
ALTER TABLE sources ADD COLUMN failure_started_at TEXT;

UPDATE sources SET failure_started_at = checked_at WHERE failures > 0 AND checked_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS sources_failure_started_at_shape_update
BEFORE UPDATE OF failure_started_at ON sources
WHEN NEW.failure_started_at IS NOT NULL AND NEW.failure_started_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.failure_started_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS sources_failure_started_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.failure_started_at IS NOT NULL AND NEW.failure_started_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.failure_started_at must be an ISO-8601 UTC instant'); END;
