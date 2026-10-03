-- `source_collection_metrics` paid 14.1 MB to index a key it could have been.
--
-- The table carried `id INTEGER PRIMARY KEY` -- a surrogate nothing reads; every caller finds a row
-- by `(source, collected_at)` -- and then `source_collection_metrics_source_time` on exactly those
-- two columns to make that findable. Measured on a copy of production on 2026-10-03, 295,133 rows:
-- table 16.84 MB, source_time index 14.14 MB, failures index 0.05 MB. The index was the largest in
-- the database and a duplicate of the key.
--
-- WITHOUT ROWID with PRIMARY KEY(source, collected_at) makes the key the table, the way 075 did for
-- `code_metrics`. Measured on the same copy: 17.82 MB for the table and 0.04 MB for the partial
-- index. 31.03 MB becomes 17.86 MB -- 13.2 MB, and one fewer b-tree to write on every collection.
--
-- The key is unique on production: 0 duplicate `(source, collected_at)` pairs across those 295,133
-- rows, which it would be, since a pair means two attempts at one source inside one millisecond.
-- It is not impossible, only unobserved, and an exception thrown there would land inside a
-- collection. So both writers gained `ON CONFLICT(source, collected_at) DO UPDATE`: a second
-- attempt in the same millisecond overwrites the first rather than failing the collection. See
-- `recordOutcome` in src/events/store.ts and the failure path in src/poller.ts.
--
-- `source_collection_metrics_failures` stays. It is a subset of the new key and 40 KB, and for a
-- source with four failures in a fortnight it is still much tighter than walking that source's
-- whole range with a filter.
--
-- Retention deleted from this table by `rowid`, which no longer exists. It deletes by the key now,
-- and that statement is in `HOT_WRITES` so the next migration to move this key has to answer for
-- it -- which is the half of the lesson 075 left: the only caller of the index this migration
-- deletes was an `INSERT ... SELECT`, and a list of hot *reads* could not see it at all.
--
-- The same trick was measured on the two other tables with a duplicate autoindex, and it is worse
-- on both. It is recorded here so that nobody re-derives it from the autoindex sizes alone:
--
--   records           19.66 MB -> 25.91 MB   (+6.25)  bodies average 470 B and reach 242 KB, so
--                                                     the key-as-table holds far fewer rows a page,
--                                                     and records_stream grew 0.45 -> 1.89 carrying
--                                                     (source, id) instead of a rowid
--   model_fact_fields  6.71 MB ->  6.81 MB   (+0.10)  the 1.68 MB autoindex goes, and
--                                                     model_fact_fields_event grows 0.32 -> 1.59
--                                                     for the same reason
--
-- A secondary index on a WITHOUT ROWID table stores the whole primary key as its row reference.
-- Counting the autoindex as free savings ignores that, and both of those tables have a secondary
-- index. This one does not, beyond a 40 KB partial subset of its own key, which is why it works
-- here and nowhere else.
--
-- Nothing about what is stored changes except the dropped `id`: same columns otherwise, same rows.
CREATE TABLE source_collection_metrics_keyed (
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL CHECK(collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  records_processed INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  changed_events INTEGER NOT NULL DEFAULT 0,
  removed_events INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  failure_kind TEXT,
  peak_rss_mb REAL,
  -- The source leads, because every read and every write of this table names one source. A day
  -- leading the key is what migration 074 did to the fold beside it, where the reads are per day;
  -- here it would turn each of those per-source seeks into a scan of the window.
  PRIMARY KEY (source, collected_at)
) WITHOUT ROWID;

-- GROUP BY, not INSERT OR REPLACE: production has no duplicate pairs, and a silent pick between
-- two rows that disagree is not what a migration should do if that ever stops being true. MAX over
-- each column keeps whichever row recorded something, and with no duplicates it is the row itself.
INSERT INTO source_collection_metrics_keyed(
  source, collected_at, success, records_processed, events_created, new_events, changed_events,
  removed_events, error, failure_kind, peak_rss_mb
)
SELECT source, collected_at, MAX(success), MAX(records_processed), MAX(events_created),
       MAX(new_events), MAX(changed_events), MAX(removed_events), MAX(error), MAX(failure_kind),
       MAX(peak_rss_mb)
FROM source_collection_metrics
GROUP BY source, collected_at;

DROP INDEX source_collection_metrics_source_time;
DROP INDEX source_collection_metrics_failures;
DROP TABLE source_collection_metrics;
ALTER TABLE source_collection_metrics_keyed RENAME TO source_collection_metrics;

CREATE INDEX source_collection_metrics_failures
  ON source_collection_metrics(source, collected_at) WHERE success = 0;

ANALYZE;
