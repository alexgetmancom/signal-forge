-- How many scouts vouched for each card, whether or not it reached the bar for promotion.
--
-- Only promoted cards were recorded, so a source whose sightings the room keeps upvoting without
-- ever reaching the bar looked exactly like one nobody reacts to. The count is read on every pass
-- over the room and the row is replaced with the latest reading.

CREATE TABLE scout_reactions (
  delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  votes INTEGER NOT NULL,
  read_at TEXT NOT NULL CHECK(read_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
