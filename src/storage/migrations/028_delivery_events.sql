-- Which message actually carried which event.
--
-- A codename is the most interesting thing this service sees and the least useful on its own: the
-- payoff is the day it resolves into a real model, and a reader only feels that payoff if the
-- resolution points back at the sighting. Discord can do that for free -- a message that references
-- an earlier one renders as a reply with a jump to it -- but only if the message that first told
-- the story can be named, and nothing here knew that.
--
-- `deliveries.external_id` has held the message id all along; what was missing is the other half of
-- the pair, because one batch pages into several messages and the event a reader wants might be on
-- the second. Batch membership is the approximation that gets this wrong, so the mapping is
-- recorded where it is known exactly: at the moment a page is built, from the embeds on it.
--
-- No backfill. Rows written before this migration cannot say which page carried what, and a link
-- to the wrong message is worse than no link.

CREATE TABLE delivery_events (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(delivery_id, event_id)
);

CREATE INDEX delivery_events_event ON delivery_events(event_id);
