-- A sent card that is edited later instead of followed by another message.
--
-- The first use is an outage: the wire is told a major incident started and, until now, never that it
-- ended, because a second message for the end interrupts everyone again. Editing the card the reader
-- already saw says it without a ping. One row per ending and card, so each card is edited once per
-- ending and never twice.

CREATE TABLE card_amendments (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'edited', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY(event_id, delivery_id)
);
