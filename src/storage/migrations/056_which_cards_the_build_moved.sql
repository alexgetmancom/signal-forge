-- Not whether this build renders something else, but which cards it renders differently.
--
-- 054 and 055 got as far as one number per boot: the hash changed, or it did not. That answers the
-- question a deploy asks first and none of the ones it asks next. A watcher who sees `caba0a9e ->
-- 4d2f91d0` learns that something moved and then has to reproduce the whole rehearsal locally to
-- find out what, which is the work the fingerprint was supposed to have already done.
--
-- One row per event per boot, so the boot that differs can be subtracted from the boot before it
-- and the answer is a list of events whose cards this build renders differently. The hash is over
-- text that already went to a channel and the row stores no upstream value: an event id and eight
-- hex characters.
--
-- Kept for the last few boots only. A corpus is about nine hundred events, so a boot is nine
-- hundred rows of forty bytes; the diff only ever reaches back to the last boot that disagreed, and
-- a service that restarts twice a day would otherwise carry a year of them for nothing.
CREATE TABLE IF NOT EXISTS release_render_cards (
  boot_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (boot_id, event_id)
) WITHOUT ROWID;

-- The whole read: every card of one boot, to subtract it from another's.
ANALYZE;
