-- Keep the thumbs down beside the thumbs up.
--
-- Only positives were stored, so a card nobody looked at and a card a reader judged not worth
-- sending held the same number: zero. That makes the column useless as an answer to "was this worth
-- delivering", which is the one question Jev's judgements need a human answer to. The bot now puts
-- both reactions under every card it sends, so an untouched card is a card nobody read, a `votes` is
-- an approval and an `against` is a refusal, and the three are finally different states.

ALTER TABLE scout_reactions ADD COLUMN against INTEGER NOT NULL DEFAULT 0;
