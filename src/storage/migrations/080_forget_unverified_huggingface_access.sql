-- The Hub's default account listing omitted gated, and the parser called that absence public.
-- On 2026-10-04 production held 2,517 such records, including seventy Meta Llama repositories;
-- the newest fifty are all gated. Only fifty repositories are read per account, so changing the
-- request alone leaves older rows claiming access the source never stated.
--
-- Remove that inferred field, including the thirty-one events it reached. Their ids, links,
-- timestamps and other fields survive, and the original upstream answers remain in snapshots.
-- A new observation requests gated explicitly and writes verified access through the usual path.
--
-- That new observation is also why `amended_records` exists. Taking a field out of a stored body
-- makes the next honest reading of it a change this service caused, and `access` is compared like
-- any other field and carries a label on a card: the first collection after this migration would
-- have sent about 950 cards -- fifty repositories for each of nineteen accounts -- each announcing
-- "Access: public" about a repository nobody touched. One row here buys one silent observation per
-- record, spent the next time that record is seen, after which a real move between gated and public
-- is news again. The table is the key with no rowid beside it, for the reason migration 075 gives.
CREATE TABLE amended_records (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  -- Which migration owes the silence, so a row left behind can be explained rather than guessed at.
  reason TEXT NOT NULL,
  PRIMARY KEY(source, id)
) WITHOUT ROWID;

-- Before the UPDATE below, while the claim this forgets is still there to be found.
INSERT INTO amended_records(source, id, reason)
SELECT source, id, '080_forget_unverified_huggingface_access'
FROM records
WHERE source LIKE 'huggingface:%' AND json_extract(body,'$.access')='public';

UPDATE records SET body=json_remove(body,'$.access')
WHERE source LIKE 'huggingface:%' AND json_extract(body,'$.access')='public';

UPDATE events SET before_json=json_remove(before_json,'$.access')
WHERE source LIKE 'huggingface:%' AND json_extract(before_json,'$.access')='public';

UPDATE events SET after_json=json_remove(after_json,'$.access')
WHERE source LIKE 'huggingface:%' AND json_extract(after_json,'$.access')='public';

-- This projection is rebuilt at boot, but clearing the derived claim here also leaves a database
-- opened by a tool honest before the rebuild has run.
DELETE FROM model_fact_fields
WHERE field LIKE 'access:huggingface:%' AND source LIKE 'huggingface:%' AND value_json='"public"';
