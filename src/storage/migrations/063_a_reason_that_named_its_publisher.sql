-- The suppression reason that named the publisher instead of the duplicate.
--
-- `published_by_a_followed_lab` held back a trending Hugging Face row whose repository the lab's own
-- account already lists, and the whole point of the rule is that the lab's own listing is what
-- readers were told from: `huggingface:Qwen` sent `Qwen/Qwen-Image-2.1` to the scouts on 2026-09-20
-- at 13:28 and the trending row for it arrived at 14:00. Read as a sentence, though, the name was an
-- argument for sending -- weights published by a lab we follow are the news -- and it read that way
-- in `judge-gap`, where every held-back row is named by its rule and nothing else.
--
-- The rule is unchanged. Only what it is called is, and the rows already recorded are renamed with
-- it: a reason is counted by string, so leaving them would split one rule across two names for as
-- long as the history is kept.
UPDATE suppressions
   SET reason = 'already_listed_by_its_lab',
       detail = 'Trending weights the lab''s own account already lists here, which is where they were read'
 WHERE reason = 'published_by_a_followed_lab';
