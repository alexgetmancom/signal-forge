-- An incident that leaves a status page was stored as `stage: resolved`, which states something the
-- vendor never stated: it stopped publishing. The card then read "identified -> resolved" directly
-- above the sentence admitting the stage was our own inference. `unlisted` is what happened, and it
-- is what the reader is told.
--
-- Bodies are compared byte for byte, so rewriting the fifteen stored rows here is what keeps the
-- change from being reported as news on the next collection. The rewrite preserves the sorted key
-- order the canonical form produces.

UPDATE records
SET body = json_set(body, '$.stage', 'unlisted')
WHERE source LIKE 'status:%'
  AND json_extract(body, '$.stage') = 'resolved'
  AND json_extract(body, '$.summary') = 'Incident no longer listed by the status page.';
