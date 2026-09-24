-- A catalogue that got smaller on purpose, accepted once by an operator.
--
-- The degradation guard refuses an answer that lost a quarter of a source's rows, because a partial
-- answer reads as a mass removal. It has no way to hear that the loss was real: arena.ai stopped
-- publishing its anonymous models on 2026-09-19 and now serves 302 of the 1083 it used to, so the
-- source has been frozen ever since, and would stay frozen forever -- the retained count is
-- compared against rows that will never be collected again.
--
-- This flag is that answer, and it is spent on use: the next collection of the source may shrink
-- however far, and storing it clears the flag. A source that then keeps shrinking is a source that
-- is genuinely broken, and the guard catches it on the poll after.

ALTER TABLE sources ADD COLUMN accept_shrink INTEGER NOT NULL DEFAULT 0;
