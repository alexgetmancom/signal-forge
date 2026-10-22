-- A card can now be edited for three reasons, and `kind` has to be able to say the third.
--
-- A reset is announced in one post and confirmed in another, so the two halves of one reset arrive
-- as two records and went out as two messages: five cycles took ten of the news channel's
-- twenty-two messages in the twelve days to 2026-10-22. The second half is now suppressed and the
-- card the first half produced is edited to say the reset landed, which is the same trade the
-- `resolved` and `priced` kinds already make -- an edit notifies nobody, and a second message
-- interrupts a reader for news the first one promised them.
--
-- A CHECK cannot be widened in place, so the table is rebuilt. Every queued row keeps its kind, and
-- `status` and `attempts` come with it: an amendment that has already failed four times must not
-- start again from zero.
CREATE TABLE card_amendments_new (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'edited', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  kind TEXT NOT NULL DEFAULT 'resolved' CHECK(kind IN ('resolved', 'priced', 'applied')),
  PRIMARY KEY(event_id, delivery_id)
);

INSERT INTO card_amendments_new(event_id, delivery_id, status, attempts, updated_at, kind)
  SELECT event_id, delivery_id, status, attempts, updated_at, kind FROM card_amendments;

DROP TABLE card_amendments;
ALTER TABLE card_amendments_new RENAME TO card_amendments;
