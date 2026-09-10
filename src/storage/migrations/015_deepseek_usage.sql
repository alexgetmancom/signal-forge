CREATE TABLE deepseek_usage (
  id INTEGER PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  attempted_at TEXT NOT NULL,
  operation TEXT NOT NULL,
  source TEXT,
  stream TEXT,
  model TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts > 0),
  input_chars INTEGER NOT NULL DEFAULT 0 CHECK(input_chars >= 0),
  response_status INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'summarized', 'unclear', 'invalid', 'rejected', 'failed', 'legacy')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  prompt_cache_hit_tokens INTEGER,
  prompt_cache_miss_tokens INTEGER,
  cost_usd REAL,
  cost_basis TEXT NOT NULL CHECK(cost_basis IN ('exact', 'estimated', 'unknown')),
  pricing_period TEXT CHECK(pricing_period IN ('peak', 'off_peak')),
  error_type TEXT
);

CREATE UNIQUE INDEX deepseek_usage_event ON deepseek_usage(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX deepseek_usage_attempted_at ON deepseek_usage(attempted_at);
CREATE INDEX deepseek_usage_operation ON deepseek_usage(operation, attempted_at);

INSERT INTO deepseek_usage(
  attempted_at,operation,model,attempts,input_chars,outcome,cost_basis
)
SELECT
  substr(key,15,10) || 'T23:59:59.999Z',
  'summary.legacy-counter',
  'deepseek-v4-flash',
  CAST(value AS INTEGER),
  0,
  'legacy',
  'unknown'
FROM app_state
WHERE key GLOB 'summary_calls_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND CAST(value AS INTEGER) > 0;

DELETE FROM app_state
WHERE key GLOB 'summary_calls_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND CAST(value AS INTEGER) > 0;
