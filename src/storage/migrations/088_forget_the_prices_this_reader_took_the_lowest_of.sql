-- Google's price list prices one model in many rows, and on 2026-10-13 this service read the lowest
-- of each rate as the model's price. Gemini 4 Argon Contributor is published at $2.00 in, $0.10
-- cached and $10.00 out per million; the card that reached the scouts said "$0.1 in · $10 out",
-- because a cache row is written "Input Caching", was read as an input price for not containing the
-- word "cached", and then won for being smaller. Fifty-two models carry such a number, and a
-- plausible number does not look like a mistake. The reader is out; see src/sources/googleSkus.ts
-- for what the next attempt has to ask for before it quotes anything.
--
-- `pricing` and `pricingTiers` go out of the records, the events and the derived claim together. The
-- upstream answers they were read from are in snapshots, as they always are, and nothing else in
-- these bodies moves: ids, names, makers and services were right and stay.

-- Before the UPDATE below, while there is still something to be silent about. One silent observation
-- per record, spent the next time that record is seen: without it the first honest poll compares a
-- body that has prices against one that does not and sends a card for every model on the list.
INSERT INTO amended_records(source, id, reason)
SELECT source, id, '088_forget_the_prices_this_reader_took_the_lowest_of'
FROM records
WHERE source='google-skus' AND (json_extract(body,'$.pricing') IS NOT NULL OR json_extract(body,'$.pricingTiers') IS NOT NULL)
ON CONFLICT(source, id) DO NOTHING;

UPDATE records SET body=json_remove(body,'$.pricing','$.pricingTiers')
WHERE source='google-skus' AND (json_extract(body,'$.pricing') IS NOT NULL OR json_extract(body,'$.pricingTiers') IS NOT NULL);

UPDATE events SET before_json=json_remove(before_json,'$.pricing','$.pricingTiers')
WHERE source='google-skus' AND (json_extract(before_json,'$.pricing') IS NOT NULL OR json_extract(before_json,'$.pricingTiers') IS NOT NULL);

UPDATE events SET after_json=json_remove(after_json,'$.pricing','$.pricingTiers')
WHERE source='google-skus' AND (json_extract(after_json,'$.pricing') IS NOT NULL OR json_extract(after_json,'$.pricingTiers') IS NOT NULL);

-- Rebuilt at boot, cleared here so a database opened by a tool before that rebuild is honest too.
DELETE FROM model_fact_fields WHERE source='google-skus' AND field='pricing:google-skus';

-- The same poll read twelve plans and modalities as models: a word standing where a codename stands
-- is refused by a list of words, and the list was short by `free`, `paid`, `generation`, `upscale`
-- and `music`. The records go, because a row that departs is reported gone and these were never
-- there; `gemini-4-argon`, the one model among the thirteen, is not in this list.
--
-- Their events stay. Deleting one cascades into `delivery_events` and `batch_events`, and what was
-- sent is the one thing this database may not revise: the thirteen went out as one digest line, and
-- a history that no longer says so cannot be read against the channel it was read in. Model Facts
-- is rebuilt at boot from what remains and is left to answer for itself.
DELETE FROM records
WHERE source='google-skus' AND id IN (
  'gemini-2.5-free','gemini-2.5-paid','gemini-3-free','gemini-3-paid','gemini-4-free','gemini-4-paid',
  'imagen-3-generation','imagen-4-generation','imagen-4-upscale','lyria-2-music','lyria-3-music','veo-3-generation'
);
