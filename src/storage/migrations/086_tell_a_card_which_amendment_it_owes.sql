-- A card can now be edited for two reasons, and the renderer is chosen by which.
--
-- Until now an amendment meant one thing: an incident that had ended, so `applyCardAmendments`
-- could call the resolved-card renderer unconditionally. A launch card that gains the price its
-- maker published after it was sent is the second, and nothing in the row said which of the two a
-- pending amendment was for.
--
-- `resolved` is the default so every row already queued keeps meaning what it meant.
ALTER TABLE card_amendments ADD COLUMN kind TEXT NOT NULL DEFAULT 'resolved'
  CHECK(kind IN ('resolved', 'priced'));
