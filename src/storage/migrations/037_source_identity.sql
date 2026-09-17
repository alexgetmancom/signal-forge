-- Who answers for a source, and for whom, as the registry declared it when the source was last
-- collected.
--
-- Current records carry neither, so Model Facts re-derived authority from a hand-kept list that had
-- fallen behind the registry on 37 of 120 sources: every generic provider catalogue read as
-- third-party and lost its provider-API fact. Independence was a third list of vendors that named
-- one maker two ways. Events already store the authority; these columns hold the same values for
-- what a source currently has. Startup rewrites both for every registered source, so the backfill
-- only covers the time before the first start.

ALTER TABLE sources ADD COLUMN authority TEXT
  CHECK(authority IS NULL OR authority IN ('first_party', 'vendor_owned', 'third_party'));
ALTER TABLE sources ADD COLUMN vendor TEXT;
UPDATE sources SET authority=(SELECT e.authority FROM events e WHERE e.source=sources.id ORDER BY e.id DESC LIMIT 1);

-- Vercel AI Gateway resells other makers' models; it never answered for them. Its five events said
-- "Listed in the provider's own API" and ranked as the maker's catalogue in Model Facts.

UPDATE events SET authority='third_party',evidence_type='availability_catalogue',confidence='observed'
WHERE source='vercel-gateway';

-- xAI, Moonshot and Poolside name the context window `context_length`, which was not read. Each
-- body below is the one the collector now builds from the response stored on production on
-- 2026-09-17, so the next collection compares equal instead of announcing 14 changed models. A row
-- that moved since then is left alone and reported as the change it is.

UPDATE records SET body='{"context":1000000,"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-0309-non-reasoning","maker":"xAI","name":"grok-4.20-0309-non-reasoning","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.20-0309-non-reasoning' AND body='{"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-0309-non-reasoning","maker":"xAI","name":"grok-4.20-0309-non-reasoning","owner":"xai"}';
UPDATE records SET body='{"context":1000000,"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-0309-reasoning","maker":"xAI","name":"grok-4.20-0309-reasoning","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.20-0309-reasoning' AND body='{"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-0309-reasoning","maker":"xAI","name":"grok-4.20-0309-reasoning","owner":"xai"}';
UPDATE records SET body='{"context":1000000,"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-multi-agent-0309","maker":"xAI","name":"grok-4.20-multi-agent-0309","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.20-multi-agent-0309' AND body='{"created":"2026-03-09T00:00:00.000Z","id":"grok-4.20-multi-agent-0309","maker":"xAI","name":"grok-4.20-multi-agent-0309","owner":"xai"}';
UPDATE records SET body='{"context":1000000,"created":"2026-04-17T00:00:00.000Z","id":"grok-4.3","maker":"xAI","name":"grok-4.3","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.3' AND body='{"created":"2026-04-17T00:00:00.000Z","id":"grok-4.3","maker":"xAI","name":"grok-4.3","owner":"xai"}';
UPDATE records SET body='{"context":500000,"created":"2026-06-29T00:00:00.000Z","id":"grok-4.5","maker":"xAI","name":"grok-4.5","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.5' AND body='{"created":"2026-06-29T00:00:00.000Z","id":"grok-4.5","maker":"xAI","name":"grok-4.5","owner":"xai"}';
UPDATE records SET body='{"context":500000,"created":"2026-08-06T00:00:00.000Z","id":"grok-4.6","maker":"xAI","name":"grok-4.6","owner":"xai"}'
 WHERE source='xai' AND id='grok-4.6' AND body='{"created":"2026-08-06T00:00:00.000Z","id":"grok-4.6","maker":"xAI","name":"grok-4.6","owner":"xai"}';
UPDATE records SET body='{"context":256000,"created":"2026-04-16T00:00:00.000Z","id":"grok-build-0.1","maker":"xAI","name":"grok-build-0.1","owner":"xai"}'
 WHERE source='xai' AND id='grok-build-0.1' AND body='{"created":"2026-04-16T00:00:00.000Z","id":"grok-build-0.1","maker":"xAI","name":"grok-build-0.1","owner":"xai"}';
UPDATE records SET body='{"context":16000,"created":"2026-01-28T00:00:00.000Z","id":"grok-imagine-image","maker":"xAI","name":"grok-imagine-image","owner":"xai"}'
 WHERE source='xai' AND id='grok-imagine-image' AND body='{"created":"2026-01-28T00:00:00.000Z","id":"grok-imagine-image","maker":"xAI","name":"grok-imagine-image","owner":"xai"}';
UPDATE records SET body='{"context":64000,"created":"2026-08-08T00:00:00.000Z","id":"grok-imagine-image-2.0","maker":"xAI","name":"grok-imagine-image-2.0","owner":"xai"}'
 WHERE source='xai' AND id='grok-imagine-image-2.0' AND body='{"created":"2026-08-08T00:00:00.000Z","id":"grok-imagine-image-2.0","maker":"xAI","name":"grok-imagine-image-2.0","owner":"xai"}';
UPDATE records SET body='{"context":16000,"created":"2026-04-03T00:00:00.000Z","id":"grok-imagine-image-quality","maker":"xAI","name":"grok-imagine-image-quality","owner":"xai"}'
 WHERE source='xai' AND id='grok-imagine-image-quality' AND body='{"created":"2026-04-03T00:00:00.000Z","id":"grok-imagine-image-quality","maker":"xAI","name":"grok-imagine-image-quality","owner":"xai"}';
UPDATE records SET body='{"context":262144,"id":"kimi-k2.7-code","maker":"Moonshot","name":"kimi-k2.7-code","owner":"moonshot"}'
 WHERE source='moonshot' AND id='kimi-k2.7-code' AND body='{"id":"kimi-k2.7-code","maker":"Moonshot","name":"kimi-k2.7-code","owner":"moonshot"}';
UPDATE records SET body='{"context":262144,"id":"kimi-k2.6","maker":"Moonshot","name":"kimi-k2.6","owner":"moonshot"}'
 WHERE source='moonshot' AND id='kimi-k2.6' AND body='{"id":"kimi-k2.6","maker":"Moonshot","name":"kimi-k2.6","owner":"moonshot"}';
UPDATE records SET body='{"context":262144,"created":"2026-06-30T14:27:25.000Z","id":"poolside/laguna-xs-2.1","maker":"Poolside","name":"Laguna XS 2.1","owner":"poolside"}'
 WHERE source='poolside' AND id='poolside/laguna-xs-2.1' AND body='{"created":"2026-06-30T14:27:25.000Z","id":"poolside/laguna-xs-2.1","maker":"Poolside","name":"Laguna XS 2.1","owner":"poolside"}';
UPDATE records SET body='{"context":262144,"created":"2026-07-06T17:09:54.000Z","id":"poolside/laguna-s-2.1","maker":"Poolside","name":"Laguna S 2.1","owner":"poolside"}'
 WHERE source='poolside' AND id='poolside/laguna-s-2.1' AND body='{"created":"2026-07-06T17:09:54.000Z","id":"poolside/laguna-s-2.1","maker":"Poolside","name":"Laguna S 2.1","owner":"poolside"}';
