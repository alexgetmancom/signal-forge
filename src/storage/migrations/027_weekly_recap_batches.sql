-- A weekly recap is a batch, not a second sender.
--
-- The public channel carries what happened the moment it happens, which leaves a reader who was
-- away with no way back in: scrolling a week of cards is not a summary. One message on Sunday --
-- models that arrived, the prices that moved furthest, what the scouts saw first -- is that way
-- back, and it is worth the most in exactly the weeks that were quiet enough to unfollow.
--
-- It goes through the machinery that already exists. `batches` holds it, `batch_targets` says where
-- it goes, `deliveries` sends it once and records the outcome, and the identity of a recap is its
-- period: one row per week per source, so a cycle that runs twice cannot post it twice. The only
-- thing the schema was missing is permission for the kind, which is a CHECK constraint and so a
-- table rebuild, by the rename-copy-drop route the runner makes safe.

ALTER TABLE batches RENAME TO batches_old;
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL CHECK(ready_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sealed INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event'
    CHECK(kind IN ('event', 'lifecycle_reminder', 'weekly_recap')),
  context_json TEXT
);
INSERT INTO batches SELECT id,source,digest,ready_at,sealed,kind,context_json FROM batches_old;
DROP TABLE batches_old;

-- One recap per period per source, enforced rather than remembered by the caller.
CREATE UNIQUE INDEX batches_recap_period ON batches(source, ready_at) WHERE kind='weekly_recap';
