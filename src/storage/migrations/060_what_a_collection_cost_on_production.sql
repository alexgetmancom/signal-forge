-- The peak a child collection reached, reported by the child that reached it.
--
-- A heavy source is collected in a process that ends, precisely so its peak dies with it -- and that
-- is also why the parent can see nothing of it. `measure` weighs a section of this process, so
-- migration 058 covers every light collector automatically; a child's peak is the hole it left, and
-- the only numbers we had for it came from one run of `source-cost` on a laptop against a copy.
--
-- The child already reads its own `VmHWM` before it exits and writes it to a log line the next deploy
-- discards. It travels back in the answer now and is stored here, so the question "what does this
-- source cost the machine it actually runs on" is answered by production, continuously, and a source
-- added tomorrow shows its number the first time it runs.
--
-- NULL for every light source, which is not a gap: those are weighed in `code_metrics` as
-- `source.collect:<id>`, in the process whose floor they raise. NULL as well for a child that was
-- killed or crashed before it could answer -- there is no honest number for a run that did not
-- finish, and the failure is already recorded beside it.

ALTER TABLE source_collection_metrics ADD COLUMN peak_rss_mb REAL;
