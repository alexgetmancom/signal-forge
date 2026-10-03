-- `code_metrics` kept its rows twice and indexed them a third time.
--
-- The table had PRIMARY KEY(name, bucket_start) without WITHOUT ROWID, so SQLite stored the rows
-- against a hidden rowid and built `sqlite_autoindex_code_metrics_1` to enforce the key beside
-- them, and `code_metrics_bucket_start` on top of that. Measured on a copy of production on
-- 2026-10-03, 173,162 rows: table 24.3 MB, autoindex 11.1 MB, time index 5.5 MB -- 41.0 MB, the
-- second-largest thing in the database and 17 MB of it index.
--
-- WITHOUT ROWID makes the key the table: one b-tree, 26.8 MB, and every read of the window gets its
-- columns out of the tree it already landed in instead of a lookup per row. The totals `timings` is
-- built on went from 191 ms to 24 ms over a fortnight of production.
--
-- The time index goes with it, which is the part that was measured rather than assumed. Three
-- shapes were timed on that copy before this was written:
--
--   PRIMARY KEY(bucket_start, name)        6,979 ms on totals -- 34x worse
--   PK(name, bucket_start) + time index    37.3 MB, timeline 100 ms
--   PK(name, bucket_start), covering       38.2 MB, timeline 16 ms
--   PK(name, bucket_start), no index       26.8 MB, timeline 45 ms   <- this
--
-- The first is what migration 074 did to the collection fold, where leading with the day turned a
-- scan into a seek; it does not transfer here, because `timings` carries a correlated subquery that
-- seeks one name's buckets and leading with the time takes that seek away. The last trades 29 ms on
-- the one report that groups by hour for 11.4 MB and one less index to write on every call, and
-- `timings` is the read that matters: it is 8x faster, not 2x slower.
--
-- Nothing about what is stored changes. Same columns, same rows, same hourly buckets.
--
-- The 14 MB this frees becomes reusable pages inside the file, not disk: dropping the old table
-- returns its pages to the freelist, and `compact-storage` is what hands them back to the
-- filesystem. Rehearsed against production at version 74 on 2026-10-03: 564 ms, integrity ok, no
-- row counts moved, and the one plan that changed is the hot read above moving from the autoindex
-- to the key.
CREATE TABLE code_metrics_keyed (
  name TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  min_duration_ms INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  duration_buckets_json TEXT NOT NULL,
  last_called_at TEXT NOT NULL CHECK(last_called_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_error_at TEXT CHECK(last_error_at IS NULL OR last_error_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_error_type TEXT,
  peak_growth_kb INTEGER NOT NULL DEFAULT 0,
  max_peak_growth_kb INTEGER NOT NULL DEFAULT 0,
  -- The name leads, because the one read that cannot be served by a scan seeks a single name's
  -- buckets. See the measurements above.
  PRIMARY KEY (name, bucket_start)
) WITHOUT ROWID;

INSERT INTO code_metrics_keyed(
  name, bucket_start, calls, failures, total_duration_ms, min_duration_ms, max_duration_ms,
  duration_buckets_json, last_called_at, last_error_at, last_error_type, peak_growth_kb,
  max_peak_growth_kb
)
SELECT name, bucket_start, calls, failures, total_duration_ms, min_duration_ms, max_duration_ms,
       duration_buckets_json, last_called_at, last_error_at, last_error_type, peak_growth_kb,
       max_peak_growth_kb
FROM code_metrics;

DROP INDEX code_metrics_bucket_start;
DROP TABLE code_metrics;
ALTER TABLE code_metrics_keyed RENAME TO code_metrics;

ANALYZE;
