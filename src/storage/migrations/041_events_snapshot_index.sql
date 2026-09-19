-- Which events a snapshot backs, found by index instead of by reading every event.
--
-- Snapshot retention keeps any snapshot an event points at, and asked that for each snapshot with a
-- correlated NOT EXISTS over events. With no index on snapshot_id every one of those was a full scan
-- of events: on production 2026-09-19 the candidate query took 15.3 s over 2,299 snapshots and 8,519
-- events, and it ran up to 200 times a cycle, which was the status worker's 17 s average. With the
-- index the same query takes 2 ms.
--
-- The index was created by hand on production when this was measured; IF NOT EXISTS makes this a
-- no-op there and the same index everywhere else.

CREATE INDEX IF NOT EXISTS events_snapshot ON events(snapshot_id);
