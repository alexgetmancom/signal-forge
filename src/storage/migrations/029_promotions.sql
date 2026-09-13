-- A message the scouts vouched for, carried into the public channel.
--
-- The invited room sees what is early and unconfirmed, which is exactly the material a machine
-- cannot grade: whether an arena entry with no name is worth a stranger's attention is a judgement,
-- and the people in that room are the ones qualified to make it. A reaction is how they make it,
-- and the owner's own reaction is the end of the argument.
--
-- What is promoted is the message, not the event: the card was already rendered, already carries
-- its evidence and its standing sentence, and re-deriving it a day later against changed records
-- would publish something the scouts never actually approved. `promoted_deliveries` is the record
-- that one has travelled, keyed by the delivery it came from, so a vote counted twice cannot post
-- twice.

ALTER TABLE batches RENAME TO batches_old;
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL CHECK(ready_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sealed INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event'
    CHECK(kind IN ('event', 'lifecycle_reminder', 'weekly_recap', 'promotion')),
  context_json TEXT
);
INSERT INTO batches SELECT id,source,digest,ready_at,sealed,kind,context_json FROM batches_old;
DROP TABLE batches_old;

CREATE UNIQUE INDEX batches_recap_period ON batches(source, ready_at) WHERE kind='weekly_recap';

CREATE TABLE promoted_deliveries (
  delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('owner', 'readers')),
  votes INTEGER NOT NULL,
  promoted_at TEXT NOT NULL CHECK(promoted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
