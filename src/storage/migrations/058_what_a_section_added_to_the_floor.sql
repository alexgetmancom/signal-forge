-- What each instrumented section added to the floor, beside how long it took.
--
-- Duration was the only thing `measure` kept, and the floor is what this service is killed for: RSS
-- is a high-water mark that is never given back, so the worst moment of a boot is the size the
-- container is sized for forever after. Every number we had about it came from a laptop -- one run
-- of `source-cost`, one run of `read-cost` -- and the third lane, what a section of the running
-- service adds, had no instrument at all.
--
-- `VmHWM` is monotone, so its increment across a section is exactly what that section raised the
-- peak by, with no sampling and nothing to miss: a rebuild that holds 200 MB for eight hundred
-- milliseconds falls between two five-minute memory samples and is still what an OOM kill is
-- decided by an hour later.
--
-- Two columns for the same reason the duration has three: `peak_growth_kb` is the sum over the
-- bucket, which says what a section costs an hour of this service's life, and `max_peak_growth_kb`
-- is the worst single call, which is the number a limit is sized from. Both are 0 where the platform
-- will not say what the peak is, and 0 for every row stored before this migration -- a section whose
-- growth is flatly 0 across a window is one that has not run since the deploy that added this.

ALTER TABLE code_metrics ADD COLUMN peak_growth_kb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE code_metrics ADD COLUMN max_peak_growth_kb INTEGER NOT NULL DEFAULT 0;
