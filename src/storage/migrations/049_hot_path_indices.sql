-- The five reads that were answered by scanning a whole table.
--
-- Measured on production 2026-09-24 with EXPLAIN QUERY PLAN against the live file, 11,131 events,
-- 24,955 records, 988 batches and 146,529 collection metrics. Each index below was chosen against a
-- plan that said SCAN, and nothing was added on the strength of a table merely being large: the
-- deliveries table takes a full scan in the delivery loop and keeps it, because it holds 633 rows
-- and an index over them would cost more to maintain than the scan costs to run.
--
-- 1. events(detected_at). Every report that asks what happened in a window -- the recap, source
--    verdicts, coverage gaps, the release audit -- filters on detected_at, and the only index
--    starting with it was events(stream, detected_at), which none of them can use because none of
--    them name a stream. The plan was SCAN events plus a temporary B-tree for the grouping, and
--    worker:status averaged 8.0 s over 4,132 runs for 33,048 s of it.
--
-- 2. events(source, entity_id, id). The oscillation guard and the delivery baseline both ask for
--    the history of one entity from one source below a given event id. events(source, id) cannot
--    narrow by entity, so SQLite walked the rowids instead: the plan read SEARCH events USING
--    INTEGER PRIMARY KEY (rowid<?), which is every event ever recorded below that id, once per
--    event per destination.
--
-- 3. batches(ready_at, id) WHERE sealed = 0. prepareDeliveries runs every 1.5 seconds and opens
--    with SCAN batches. 988 rows is a small scan; 57,600 of them a day against a table with no
--    ceiling is not, and the partial index holds only the handful of batches still open.
--
-- 4. records(stream). knownModelNames reads every catalogue record to learn which model names are
--    already known, filtered by four streams out of 24,955 rows, and the plan was SCAN records. It
--    is called while deciding whether an event is worth a card.
--
-- 5. source_collection_metrics(collected_at). The retention added alongside this migration deletes
--    by age, and the only index on the table starts with source, which a delete by cutoff cannot
--    use. Without this the first prune would scan 146,529 rows for every chunk it takes.

CREATE INDEX IF NOT EXISTS events_detected_at ON events(detected_at);

CREATE INDEX IF NOT EXISTS events_source_entity ON events(source, entity_id, id);

CREATE INDEX IF NOT EXISTS batches_open_ready ON batches(ready_at, id) WHERE sealed = 0;

CREATE INDEX IF NOT EXISTS records_stream ON records(stream);

CREATE INDEX IF NOT EXISTS source_collection_metrics_collected ON source_collection_metrics(collected_at);

-- And the statistics that make the planner believe them.
--
-- Four of the five indexes above were ignored on first measurement against a copy of production:
-- the plan for the open-batch query still read SCAN batches with the partial index sitting right
-- there, and `INDEXED BY` proved it usable. Without sqlite_stat1 SQLite guesses at how selective an
-- index is, and its guess for a 989-row table was that scanning it beat seeking into it. ANALYZE
-- replaced the guess with the counts, and the same query became a covering index search. It costs
-- 49 ms on the 344 MB copy this was measured against.
ANALYZE;
