-- Keep the class an event was routed by on the event.
--
-- The class was computed twice: once by the store, with the database in hand, to pick the channels,
-- and again by every report from the event alone. The two disagreed as soon as a rule needed the
-- database -- a docs page for a model already on sale was routed as evidence and counted as a
-- sighting. The store now writes its answer here and the reports read it. Rows from before stay
-- NULL and are classified the old way.

ALTER TABLE events ADD COLUMN signal TEXT;
