ALTER TABLE records ADD COLUMN stream TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN observed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE records
SET stream = COALESCE(
  (
    SELECT e.stream
    FROM events e
    WHERE e.source = records.source AND e.entity_id = records.id
    ORDER BY e.id DESC
    LIMIT 1
  ),
  CASE
    WHEN source = 'openrouter' THEN 'openrouter'
    WHEN source IN ('openai', 'anthropic', 'gemini', 'deepseek-pricing', 'vercel-gateway') THEN 'api-models'
    WHEN source IN ('openai-news', 'openai-chatgpt-release-notes', 'anthropic-news', 'gemini-api-changelog', 'xai-release-notes', 'mistral-release-notes', 'groq-changelog', 'deepseek-updates', 'claude-code-changelog', 'anthropic-sdk-releases', 'google-deepmind-feed', 'nvidia-ai-feed', 'huggingface-blog-feed') THEN 'news'
    WHEN source IN ('codex-docs', 'claude-web', 'cursor-changelog') THEN 'web'
    WHEN source = 'arena' THEN 'arena'
    WHEN source = 'arena-leaderboards' OR source LIKE 'designarena:%' THEN 'leaderboards'
    WHEN source LIKE 'status:%' THEN 'incidents'
    WHEN source LIKE 'github:%' OR source LIKE 'discovery:github-%' THEN 'github'
    WHEN source LIKE 'huggingface:%' OR source = 'discovery:huggingface-recent' OR source LIKE 'modelscope:%' THEN 'weights'
    WHEN source LIKE 'npm:%' OR source LIKE 'pypi:%' THEN 'packages'
    WHEN source LIKE '%-deprecations' THEN 'deprecations'
    ELSE ''
  END
)
WHERE stream = '';

UPDATE records
SET observed_at = COALESCE(
  (SELECT last_success FROM sources WHERE sources.id = records.source),
  (SELECT MAX(collected_at) FROM snapshots WHERE snapshots.source = records.source),
  observed_at
)
WHERE observed_at = '1970-01-01T00:00:00.000Z';

DROP INDEX IF EXISTS model_fact_fields_event;
ALTER TABLE model_fact_fields RENAME TO model_fact_fields_before_current_observations;

CREATE TABLE model_fact_fields (
  canonical_id TEXT NOT NULL REFERENCES model_facts(canonical_id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  evidence_type TEXT NOT NULL,
  source TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(canonical_id, field)
);

INSERT INTO model_fact_fields(
  canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at
)
SELECT
  canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at
FROM model_fact_fields_before_current_observations;

UPDATE model_fact_fields
SET field = field || ':' || source
WHERE field IN ('pricing', 'access', 'availableInProviderApi', 'availableOnOpenRouter', 'openWeights');

DROP TABLE model_fact_fields_before_current_observations;

CREATE INDEX model_fact_fields_event ON model_fact_fields(event_id);
