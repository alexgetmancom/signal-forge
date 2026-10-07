-- Who raised a batch, which no column said.
--
-- 919 of them hold `kind='event', digest=0`, and that one group mixes normal routing, a card an
-- operator sent again by hand, a card corroboration raised when three sources agreed, and a card a
-- breakout raised for a name that took off. The question "how often does this feed repeat itself"
-- is asked of exactly that group, and answering it meant joining `operator_journal` by timestamp
-- within ten seconds. The first histogram built that way was wrong: it showed a four-card day for
-- Mistral Large 4 that was event 52353 sent three extra times while card renders were being
-- checked, and a plausible number does not look like a mistake.
--
-- `kind` and `digest` are not this question. `kind` says what sort of message it is -- a weekly
-- recap, a lifecycle reminder, a promotion -- and `digest` says whether it waits for the hour. Both
-- are properties of the message; this is the rule, or the person, that decided there would be one.
--
-- Nullable, and stays nullable, for the reason migration 084's column is. Every batch stored before
-- this was raised without the answer being recorded, and only some of them can be worked out after
-- the fact -- a resend is indistinguishable from routing in this table, which is the whole reason
-- the column exists. A default would make 919 rows claim an origin nobody wrote down. A report that
-- counts these reads a null as "not recorded" rather than as "policy".
ALTER TABLE batches ADD COLUMN origin TEXT CHECK(
  origin IS NULL
  OR origin IN ('policy', 'digest', 'resend', 'corroboration', 'breakout', 'reminder', 'recap', 'promotion')
);
