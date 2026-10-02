-- A source the registry no longer names says so in its own row.
--
-- `sources` keeps a row for every source that has ever run, and the registry -- code, rebuilt on
-- every boot -- is the list of the ones still being asked. Which rows belong to nothing was a fact
-- only the registry knew, so every read of the table as a list had to build the registry first, and
-- `check-sql` refuses the ones that do not. Eight rows on production were already in that state
-- (four designarena boards, two feeds, two desktop apps), and a raw `GROUP BY` from `sql` counted
-- them as live collectors.
--
-- `retired_at` is the instant a boot found the row's id missing from the registry. Startup stamps
-- it, and clears it again for a source the registry names, so a source that comes back is not
-- retired and one that goes away is. A row is never deleted: its snapshots, events and metrics
-- still answer for it, and `source` reads it by name.
--
-- `live_sources` is the same table without them. It is what a hand-written read of "the sources"
-- should name, and `check-sql` does not treat it as a read of `sources`, because it cannot include
-- a retired one. `SELECT *` is deliberate: a column added to `sources` later is in the view without
-- a second migration to remember.
--
-- Nothing is backfilled here, because only the registry can say which rows are retired. Until the
-- first boot on this schema every row reads as live, which is what the table already implied.

ALTER TABLE sources ADD COLUMN retired_at TEXT
  CHECK(retired_at IS NULL OR retired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z');

CREATE VIEW live_sources AS SELECT * FROM sources WHERE retired_at IS NULL;
