-- Between the deploy that taught a destination to say whether its presses are a measurement and the
-- config edit that said it, the owner's own two channels were read as rooms with readers for one
-- pass. On 2026-10-04 at 09:05:54Z that pass wrote 58 rows -- nine for the release desk, forty-nine
-- for the trail -- every one of them zero in favour and zero against, because the only thumbs under
-- those cards were the bot's own.
--
-- A zero row is not harmless. `scout_reactions` is read in two ways: the tallies skip rows with no
-- votes, so the counts were never wrong, but `judgeCalibration` counts a row as a card a reader
-- opened, and 58 cards nobody could have opened sat in the denominator it calibrates the judge
-- against. The rows are removed by the instant they were written rather than by channel, so a
-- genuine zero recorded in a reader's channel is left where it is: the two channels are named, and
-- so is the instant, because a row in a reader's channel is rewritten on every pass and one left
-- standing at that instant would be a card that has since gone cold rather than one of these.
DELETE FROM scout_reactions WHERE delivery_id IN (
  SELECT r.delivery_id FROM scout_reactions r JOIN deliveries d ON d.id = r.delivery_id
   WHERE d.destination_id IN ('discord-desk', 'discord-trail')
     AND r.votes = 0 AND r.against = 0 AND r.read_at = '2026-10-04T09:05:54.041Z'
);
