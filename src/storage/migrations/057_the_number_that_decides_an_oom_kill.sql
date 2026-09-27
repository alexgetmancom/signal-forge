-- Anonymous and file-backed memory, beside the container total that was already sampled.
--
-- `cgroup_current_mb` and `cgroup_peak_mb` count the page cache, and on this deployment the page
-- cache is the database: 472 MB of app.db, read once, left the container's recorded peak at 1,009 MB
-- of a 1,024 MB limit on 2026-09-27 while the service held 174 MB of anonymous pages. Read as
-- headroom that is 15 MB, and the limit was nearly raised on it. The kernel reclaims that cache
-- before it kills anything -- at 00:38Z that day `memory.current` fell 822 -> 385 MB inside one boot
-- for one major fault -- so `anon_mb` is the number an OOM kill is decided by and the one a limit is
-- sized from. `file_mb` is stored beside it so a large total can be told from a large service
-- without a second question.
--
-- Older rows keep NULL in both: the report falls back to the container total for those, and says so.

ALTER TABLE memory_samples ADD COLUMN anon_mb REAL;
ALTER TABLE memory_samples ADD COLUMN file_mb REAL;
