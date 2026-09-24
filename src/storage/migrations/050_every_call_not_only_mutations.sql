-- What was asked, not only what was changed.
--
-- The journal held mutations, because the question it was built for is "has somebody already
-- settled this by hand". `code_metrics` held the other half: cli.command:sql has been called 558
-- times. Between them they say a command ran and say nothing about what it was asked -- and for a
-- repository where every commit is made by an agent, the arguments are the signal. The 558 `sql`
-- calls are 558 questions no command could answer, and each one that keeps recurring is a command
-- that should exist. On 2026-09-24 one of them was asked wrongly: `deliveries` grouped by
-- destination_id, which counts five destinations that were retired, and the wrong answer went into
-- a report. `destinations` exists now because that question was asked by hand twice.
--
-- So every call is recorded, and `mutates` keeps the two kinds apart: `journal` still answers its
-- own question by reading only the mutations, and `usage` reads the rest.

ALTER TABLE operator_journal ADD COLUMN mutates INTEGER NOT NULL DEFAULT 1;
ALTER TABLE operator_journal ADD COLUMN duration_ms INTEGER;

-- Reads are the bulk from here on, and `journal` wants the mutations out of them without a scan.
CREATE INDEX IF NOT EXISTS operator_journal_mutations ON operator_journal(mutates, id DESC);

-- Body expiry reads the unexpired snapshots and nothing else, and the full index on
-- collected_at cannot help it: the horizon depends on the row's own size, so the planner had no
-- range to seek and scanned the table every status cycle. This is a partial index over exactly
-- the working set, and it shrinks as the bodies it names are released.
CREATE INDEX IF NOT EXISTS snapshots_unexpired ON snapshots(collected_at) WHERE body IS NOT NULL;

-- 049 learned the lesson: an index the planner has no statistics for is an index it will not use,
-- and from outside that is indistinguishable from an index that does not exist.
ANALYZE;
