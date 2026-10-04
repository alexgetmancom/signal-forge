-- What each collection asked of the network, beside what it produced from it.
--
-- The question these columns exist for is which source to narrow next, and until now nothing in
-- this database could answer it. `snapshots` weighs stored bodies, which is what survived retention
-- and compression, and says nothing at all about a source that stores none; the two GitHub
-- discovery reads that turned out to be fetching 474 KB for 55 KB of used fields were found by
-- hand, against the live endpoint, and there was no list saying where to look next. A new source
-- arrives every few weeks and asking each one by hand does not scale, so the counting moves into
-- the one place every request already passes through.
--
-- They are columns on the attempt rather than a table of their own because a byte count is only
-- ever read against what the attempt produced -- bytes per event is the ranking, not bytes -- and a
-- second table keyed by the same pair would be a join on every read and a second thing to prune.
ALTER TABLE source_collection_metrics ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_collection_metrics ADD COLUMN bytes_decoded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_collection_metrics ADD COLUMN bytes_wire INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_collection_metrics ADD COLUMN not_modified INTEGER NOT NULL DEFAULT 0;

-- And on the fold, which is where every count of collections is read from. Raw attempts keep
-- fourteen days; the ranking this is for is a question about weeks, so it has to survive the prune.
--
-- Zero and null are different answers here and both are kept: zero is a collection that asked for
-- nothing, null is one that ran before anything was counted. A default of 0 on the days table would
-- make every day of history claim a source downloaded nothing, which is the one reading that would
-- send a reader to narrow a source that is already free.
ALTER TABLE source_collection_days ADD COLUMN requests INTEGER;
ALTER TABLE source_collection_days ADD COLUMN bytes_decoded INTEGER;
ALTER TABLE source_collection_days ADD COLUMN bytes_wire INTEGER;
ALTER TABLE source_collection_days ADD COLUMN not_modified INTEGER;

-- No index: every reader of this is the existing window over `source_collection_days`, which seeks
-- on the (day, source, outcome) primary key the table already is, and these are four more columns
-- read out of the row it lands in. An index named by no read is the thing `check-indexes` exists
-- to refuse.
ANALYZE;
