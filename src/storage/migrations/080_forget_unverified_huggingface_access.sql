-- The Hub's default account listing omitted gated, and the parser called that absence public.
-- On 2026-10-04 production held 2,517 such records, including seventy Meta Llama repositories;
-- the newest fifty are all gated. Only fifty repositories are read per account, so changing the
-- request alone leaves older rows claiming access the source never stated.
--
-- Remove that inferred field, including the thirty-one events it reached. Their ids, links,
-- timestamps and other fields survive, and the original upstream answers remain in snapshots.
-- A new observation requests gated explicitly and writes verified access through the usual path.
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
