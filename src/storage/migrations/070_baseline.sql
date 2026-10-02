-- The whole schema, as one statement list.
--
-- Migrations 025 to 070 were squashed into this file once production had reached the end of that
-- journal. Forty-five files -- seventeen creating a table, sixteen adding a column, fifteen adding
-- an index and four rebuilding a table, some doing more than one -- were replayed by every new
-- database and every test, each in a transaction of its own with a foreign-key check after it, to
-- arrive at a shape no database was ever going to start from again. What they did and why is in the
-- git log; the numbers that comments elsewhere give ("migration 059", "see 062") are the numbers of
-- that journal.
--
-- It is numbered 070 because that is the version it produces. Production already holds that
-- version and so has nothing to run; a new database runs this one file and arrives there directly.
-- An archive older than the squash carries a lower version, and this file cannot walk it forward:
-- check it out at the commit before the squash, migrate it there, and come back. The runner says so
-- rather than failing on the first table that already exists.
--
-- Tables come parents first. Timestamps are UTC ISO-8601 strings with millisecond precision, and the
-- GLOB check on each timestamp column is what enforces that.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  checked_at TEXT CHECK(checked_at IS NULL OR checked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT CHECK(retry_at IS NULL OR retry_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failure_started_at TEXT CHECK(failure_started_at IS NULL OR failure_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  authority TEXT CHECK(authority IS NULL OR authority IN ('first_party', 'vendor_owned', 'third_party')),
  vendor TEXT,
  accept_shrink INTEGER NOT NULL DEFAULT 0,
  last_error_kind TEXT,
  first_observed_at TEXT CHECK(first_observed_at IS NULL OR first_observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  evidence_type TEXT CHECK(evidence_type IS NULL OR evidence_type IN ('api_catalogue', 'availability_catalogue', 'official_news', 'arena_roster', 'leaderboard', 'web_diff', 'github_activity', 'binary_string', 'package_release', 'open_weights', 'status_page', 'deprecation', 'unknown')),
  confidence TEXT CHECK(confidence IS NULL OR confidence IN ('observed', 'supported', 'confirmed'))
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL CHECK(collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  body BLOB,
  hash TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  expired_at TEXT CHECK(expired_at IS NULL OR expired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX snapshots_source_hash ON snapshots(source, hash);
CREATE INDEX snapshots_collected ON snapshots(collected_at);
CREATE INDEX snapshots_unexpired ON snapshots(collected_at) WHERE body IS NOT NULL;

CREATE TABLE records (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  missing_count INTEGER NOT NULL DEFAULT 0,
  stream TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  candidate_body TEXT,
  PRIMARY KEY(source, id)
);
CREATE INDEX records_stream ON records(stream);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  stream TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new', 'changed', 'removed')),
  before_json TEXT,
  after_json TEXT,
  detected_at TEXT NOT NULL CHECK(detected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  evidence_type TEXT NOT NULL DEFAULT 'unknown' CHECK(evidence_type IN ('api_catalogue', 'availability_catalogue', 'official_news', 'arena_roster', 'leaderboard', 'web_diff', 'github_activity', 'binary_string', 'package_release', 'open_weights', 'status_page', 'deprecation', 'unknown')),
  authority TEXT NOT NULL DEFAULT 'third_party' CHECK(authority IN ('first_party', 'vendor_owned', 'third_party')),
  signal TEXT,
  speaks INTEGER CHECK(speaks IS NULL OR speaks IN (0,1))
);
CREATE INDEX events_stream_time ON events(stream, detected_at);
CREATE INDEX events_snapshot ON events(snapshot_id);
CREATE INDEX events_detected_at ON events(detected_at);
CREATE INDEX events_source_entity ON events(source, entity_id, id);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL CHECK(ready_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sealed INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event' CHECK(kind IN ('event', 'lifecycle_reminder', 'weekly_recap', 'promotion')),
  context_json TEXT
);
CREATE UNIQUE INDEX batches_recap_period ON batches(source, ready_at) WHERE kind='weekly_recap';
CREATE INDEX batches_open_ready ON batches(ready_at, id) WHERE sealed = 0;

CREATE TABLE batch_events (
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  signal TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(batch_id, event_id)
);
CREATE INDEX batch_events_signal ON batch_events(batch_id, signal);

CREATE TABLE batch_targets (
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  PRIMARY KEY(batch_id, destination_id)
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE summaries (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fresh_until_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(fresh_until_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  body TEXT NOT NULL,
  used_at TEXT NOT NULL CHECK(used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  destination_id TEXT NOT NULL,
  -- The destination as it was when the message was built: a sent delivery is the record of where
  -- it actually went, which outlives whatever the batch target says later.
  destination_json TEXT NOT NULL,
  body TEXT NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous', 'verification_required')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(next_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  external_id TEXT,
  error TEXT,
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  verification_source TEXT,
  verified_at TEXT CHECK(verified_at IS NULL OR verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  last_verification_error TEXT,
  UNIQUE(batch_id, destination_id, part)
);
CREATE INDEX deliveries_pending ON deliveries(status, next_attempt_at);

CREATE TABLE source_collection_metrics (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL CHECK(collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  records_processed INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  changed_events INTEGER NOT NULL DEFAULT 0,
  removed_events INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  failure_kind TEXT,
  peak_rss_mb REAL
);
CREATE INDEX source_collection_metrics_source_time ON source_collection_metrics(source, collected_at);
CREATE INDEX source_collection_metrics_collected ON source_collection_metrics(collected_at);
CREATE INDEX source_collection_metrics_failures ON source_collection_metrics(source, collected_at) WHERE success = 0;

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  vendor TEXT NOT NULL,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  current_status TEXT NOT NULL DEFAULT 'active' CHECK(current_status IN ('active', 'removed')),
  released_at TEXT CHECK(released_at IS NULL OR released_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX stories_updated ON stories(updated_at);
CREATE INDEX stories_released ON stories(released_at);

CREATE TABLE story_events (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(story_id, event_id)
);
CREATE INDEX story_events_event ON story_events(event_id);

CREATE TABLE model_facts (
  canonical_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  canonical_key TEXT NOT NULL DEFAULT ''
);
CREATE INDEX model_facts_updated ON model_facts(updated_at);
CREATE INDEX model_facts_key ON model_facts(canonical_key);

CREATE TABLE model_fact_conflicts (
  canonical_id TEXT NOT NULL,
  field TEXT NOT NULL,
  incumbent_event_id INTEGER NOT NULL REFERENCES events(id),
  challenger_event_id INTEGER NOT NULL REFERENCES events(id),
  detected_at TEXT NOT NULL CHECK(detected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY(canonical_id, field, incumbent_event_id, challenger_event_id)
);

CREATE TABLE hypotheses (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('emerging', 'strengthening', 'confirmed', 'stale')),
  independent_source_count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  formed_at TEXT NOT NULL CHECK(formed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  resolution_event_id INTEGER REFERENCES events(id)
);
CREATE INDEX hypotheses_updated ON hypotheses(updated_at);

CREATE TABLE hypothesis_events (
  hypothesis_id INTEGER NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  role TEXT NOT NULL CHECK(role IN ('supporting', 'resolution')),
  PRIMARY KEY(hypothesis_id, event_id)
);
CREATE INDEX hypothesis_events_event ON hypothesis_events(event_id);

CREATE TABLE lifecycle_deadlines (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  canonical_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  deadline_type TEXT NOT NULL CHECK(deadline_type IN ('deprecation', 'retirement', 'shutdown')),
  deadline_at TEXT NOT NULL CHECK(deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  replacement TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX lifecycle_deadlines_time ON lifecycle_deadlines(deadline_at);

CREATE TABLE lifecycle_reminders (
  deadline_id INTEGER NOT NULL REFERENCES lifecycle_deadlines(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  due_at TEXT NOT NULL CHECK(due_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  batch_id INTEGER REFERENCES batches(id),
  PRIMARY KEY(deadline_id, offset_days)
);
CREATE INDEX lifecycle_reminders_due ON lifecycle_reminders(due_at);

CREATE TABLE code_metrics (
  name TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  min_duration_ms INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  duration_buckets_json TEXT NOT NULL,
  last_called_at TEXT NOT NULL CHECK(last_called_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_error_at TEXT CHECK(last_error_at IS NULL OR last_error_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_error_type TEXT,
  peak_growth_kb INTEGER NOT NULL DEFAULT 0,
  max_peak_growth_kb INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(name, bucket_start)
);
CREATE INDEX code_metrics_bucket_start ON code_metrics(bucket_start);

CREATE TABLE deepseek_usage (
  id INTEGER PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  attempted_at TEXT NOT NULL CHECK(attempted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
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
  error_type TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 2)
);
CREATE INDEX deepseek_usage_attempted_at ON deepseek_usage(attempted_at);
CREATE INDEX deepseek_usage_operation ON deepseek_usage(operation, attempted_at);
CREATE UNIQUE INDEX deepseek_usage_event ON deepseek_usage(event_id, attempt) WHERE event_id IS NOT NULL;

CREATE TABLE alert_attempts (
  id INTEGER PRIMARY KEY,
  state_version INTEGER NOT NULL UNIQUE,
  from_state_json TEXT NOT NULL,
  to_state_json TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(next_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  error TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX alert_attempts_due ON alert_attempts(status, next_attempt_at);

CREATE TABLE model_fact_fields (
  canonical_id TEXT NOT NULL REFERENCES model_facts(canonical_id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  evidence_type TEXT NOT NULL,
  source TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY(canonical_id, field)
);
CREATE INDEX model_fact_fields_event ON model_fact_fields(event_id);

CREATE TABLE suppressions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  destination_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (event_id, destination_id)
);
CREATE INDEX suppressions_recorded_at ON suppressions(recorded_at);

CREATE TABLE credential_circuits (
  capability_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('open', 'cleared')),
  status_code INTEGER,
  source TEXT NOT NULL,
  detail TEXT NOT NULL,
  rejections INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL CHECK(opened_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_rejected_at TEXT NOT NULL CHECK(last_rejected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  cleared_at TEXT CHECK(cleared_at IS NULL OR cleared_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE action_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL CHECK(acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE operator_journal (
  id INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  surface TEXT NOT NULL CHECK(surface IN ('cli', 'http', 'mcp')),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'rejected', 'failed')),
  detail TEXT,
  mutates INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER
);
CREATE INDEX operator_journal_recorded_at ON operator_journal(recorded_at DESC, id DESC);
CREATE INDEX operator_journal_mutations ON operator_journal(mutates, id DESC);

CREATE TABLE publications (
  ref TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL UNIQUE,
  published_at TEXT CHECK(published_at IS NULL OR published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  status TEXT NOT NULL,
  headline TEXT NOT NULL,
  text_en TEXT,
  targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
  checked_at TEXT NOT NULL CHECK(checked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX publications_date ON publications(published_at);

CREATE TABLE delivery_events (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(delivery_id, event_id)
);
CREATE INDEX delivery_events_event ON delivery_events(event_id);

CREATE TABLE promoted_deliveries (
  delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('owner', 'readers')),
  votes INTEGER NOT NULL,
  promoted_at TEXT NOT NULL CHECK(promoted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE weight_totals (
  total INTEGER PRIMARY KEY,
  first_model TEXT NOT NULL,
  first_published TEXT NOT NULL CHECK(first_published GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE card_amendments (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'edited', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY(event_id, delivery_id)
);

CREATE TABLE scout_reactions (
  delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  votes INTEGER NOT NULL,
  read_at TEXT NOT NULL CHECK(read_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  against INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_samples (
  sampled_at TEXT PRIMARY KEY CHECK(sampled_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  boot_id TEXT,
  rss_mb REAL NOT NULL,
  heap_used_mb REAL NOT NULL,
  cgroup_current_mb REAL,
  cgroup_peak_mb REAL,
  cgroup_limit_mb REAL,
  oom_kills INTEGER,
  anon_mb REAL,
  file_mb REAL
);

CREATE TABLE event_evaluations (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  evaluator TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  worth INTEGER NOT NULL,
  codename REAL NOT NULL,
  confidence REAL,
  rules TEXT NOT NULL,
  evaluated_at TEXT NOT NULL CHECK(evaluated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (event_id, evaluator, prompt_version)
);
CREATE INDEX event_evaluations_evaluated ON event_evaluations(evaluated_at);

CREATE TABLE telegram_reactions (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(chat_id, message_id, actor, emoji)
);

CREATE TABLE telegram_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  next_update INTEGER NOT NULL
);

CREATE TABLE model_fact_members (
  kind TEXT NOT NULL CHECK(kind IN ('story', 'record')),
  ref TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
) WITHOUT ROWID;
CREATE INDEX model_fact_members_key ON model_fact_members(canonical_key);

CREATE TABLE source_failure_evidence (
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  kind TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (source, observed_at)
) WITHOUT ROWID;
CREATE INDEX source_failure_evidence_recent ON source_failure_evidence(source, observed_at DESC);

CREATE TABLE source_shapes (
  source TEXT NOT NULL,
  hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_seen_at TEXT NOT NULL CHECK(last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  seen INTEGER NOT NULL DEFAULT 1,
  paths INTEGER NOT NULL,
  shape_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  PRIMARY KEY (source, hash)
) WITHOUT ROWID;
CREATE INDEX source_shapes_recent ON source_shapes(source, last_seen_at DESC);

CREATE TABLE release_renders (
  boot_id TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL CHECK(computed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  booted_at TEXT NOT NULL CHECK(booted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  hash TEXT NOT NULL,
  cards INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  took_ms INTEGER NOT NULL,
  corpus TEXT
) WITHOUT ROWID;
CREATE INDEX release_renders_recent ON release_renders(booted_at DESC);

CREATE TABLE release_render_cards (
  boot_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (boot_id, event_id)
) WITHOUT ROWID;

CREATE TABLE story_claims (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  claim TEXT NOT NULL CHECK(claim IN ('existence', 'availability', 'identity')),
  confidence TEXT NOT NULL CHECK(confidence IN ('observed', 'supported', 'confirmed')),
  -- When any event first carried this claim at any strength.
  first_at TEXT NOT NULL CHECK(first_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- When it reached the confidence it now holds, which is the date a rise actually happened.
  raised_at TEXT NOT NULL CHECK(raised_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  supported_by TEXT NOT NULL,
  PRIMARY KEY(story_id, claim)
) WITHOUT ROWID;

-- Statistics for the planner: without sqlite_stat1 it ignores an index it has not been told is
-- selective (see src/storage/hotQueries.ts). A new database is empty, so this creates the table that
-- `PRAGMA optimize` keeps current afterwards.
ANALYZE;
