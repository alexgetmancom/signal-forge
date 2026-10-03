-- One row per source, day and outcome, folded from the raw attempts beside it.
--
-- 356,345 raw rows weighed 21 MB with 30 MB of indexes on production, a third of the database, for
-- a table whose every reader asks for counts. The same history as days is some twenty thousand
-- rows, so the raw attempts need only outlive the detail nothing else can answer: the minute an
-- outage clustered in, and the sentence a failure carried.
--
-- `outcome` is 'success' or the failure's kind, so a day's attempts are the sum over its outcomes
-- and the kind breakdown needs no second table. The CASE repeats FAILURE_KIND in src/reports
-- because a migration cannot import it; the fold that keeps this current reads the constant.
CREATE TABLE source_collection_days (
  source TEXT NOT NULL,
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  records_processed INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  changed_events INTEGER NOT NULL DEFAULT 0,
  removed_events INTEGER NOT NULL DEFAULT 0,
  -- The worst child peak of the day, and the two halves of its average: a mean of means weights a
  -- day with one collection like a day with four hundred.
  peak_rss_max REAL,
  peak_rss_total REAL,
  peak_rss_samples INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL CHECK(first_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_at TEXT NOT NULL CHECK(last_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- The day leads the key, and the table is WITHOUT ROWID, so the primary key index is the table:
  -- a report asking for a window seeks to its first day and reads every column from the index it
  -- landed in. Source first would make the same window a full scan, which is what it was measured
  -- as before this was turned around.
  PRIMARY KEY (day, source, outcome)
) WITHOUT ROWID;

INSERT INTO source_collection_days(
  source, day, outcome, attempts, records_processed, events_created, new_events, changed_events,
  removed_events, peak_rss_max, peak_rss_total, peak_rss_samples, first_at, last_at
)
SELECT source,
       substr(collected_at, 1, 10),
       CASE
         WHEN success = 1 THEN 'success'
         ELSE COALESCE(
           failure_kind,
           CASE WHEN error LIKE 'Collection degraded:%' THEN 'degraded' ELSE 'before_kinds_were_recorded' END
         )
       END,
       COUNT(*),
       SUM(records_processed),
       SUM(events_created),
       SUM(new_events),
       SUM(changed_events),
       SUM(removed_events),
       MAX(peak_rss_mb),
       SUM(peak_rss_mb),
       SUM(peak_rss_mb IS NOT NULL),
       MIN(collected_at),
       MAX(collected_at)
FROM source_collection_metrics
GROUP BY 1, 2, 3;

ANALYZE;
