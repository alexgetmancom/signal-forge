-- Every parameter count ever published, and who published it first.
--
-- A laboratory's release and a stranger's copy of it are indistinguishable by popularity on the day
-- the weights land, and nearly indistinguishable by metadata: a copy that declares no base model
-- looks exactly like an original. It differs in one place. The parameter count is a property of the
-- weights themselves, so a copy reproduces it exactly -- `schwyzquants/GLM-5.3` carries
-- 753,329,940,480 parameters, the count of the model it copied -- and whoever published that count
-- first is the origin.
--
-- Comparing within a collection sweep only catches a copy published beside its original. This is
-- the ledger that catches one published a week later, which was eight of the twelve repositories a
-- twelve-hour sweep marked on 2026-09-14.
--
-- The first publisher is kept, not merely the count, so that re-reading the original on every poll
-- keeps answering "novel": `records.body` is compared byte for byte and a verdict that flipped on
-- the second look would report a change that did not happen.

CREATE TABLE weight_totals (
  total INTEGER PRIMARY KEY,
  first_model TEXT NOT NULL,
  first_seen TEXT NOT NULL CHECK(first_seen GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
