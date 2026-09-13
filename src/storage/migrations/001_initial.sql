-- The whole schema, as one statement list.
--
-- Migrations 001 to 025 were squashed into this file once the only database had reached the end of
-- that journal: replaying twenty-five steps to arrive at a shape no database was ever going to
-- start from again was history, and history lives in the git log. A database that is not already
-- this shape does not exist; if one is ever restored from a backup older than the squash, check it
-- out at the commit that introduced this file and migrate it there first.
--
-- Timestamps are UTC ISO-8601 strings, and the triggers below are what enforce that.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  checked_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  failure_started_at TEXT
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  body BLOB,
  hash TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  expired_at TEXT
);

CREATE TABLE records (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  missing_count INTEGER NOT NULL DEFAULT 0,
  stream TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  PRIMARY KEY(source, id)
);

CREATE TABLE change_candidates (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  observations INTEGER NOT NULL,
  PRIMARY KEY(source, id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  stream TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new', 'changed', 'removed')),
  before_json TEXT,
  after_json TEXT,
  detected_at TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  confidence TEXT NOT NULL DEFAULT 'observed'
    CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  evidence_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(evidence_type IN (
    'api_catalogue',
    'availability_catalogue',
    'official_news',
    'arena_roster',
    'leaderboard',
    'web_diff',
    'github_activity',
    'package_release',
    'open_weights',
    'status_page',
    'deprecation',
    'unknown'
    )),
  authority TEXT NOT NULL DEFAULT 'third_party'
    CHECK(authority IN ('first_party', 'vendor_owned', 'third_party'))
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event'
    CHECK(kind IN ('event', 'lifecycle_reminder')),
  context_json TEXT
);

CREATE TABLE batch_events (
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  signal TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(batch_id, event_id)
);

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
  created_at TEXT NOT NULL
);

CREATE TABLE http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fresh_until INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE INDEX events_source ON events(source, id);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  destination_id TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  body TEXT NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous', 'verification_required')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  verification_source TEXT,
  verified_at TEXT,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  last_verification_error TEXT,
  UNIQUE(batch_id, destination_id, part)
);

CREATE INDEX deliveries_pending ON deliveries(status, next_attempt);

CREATE TABLE source_collection_metrics (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  records_processed INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  changed_events INTEGER NOT NULL DEFAULT 0,
  removed_events INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX source_collection_metrics_source_time ON source_collection_metrics(source, collected_at);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  vendor TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  current_status TEXT NOT NULL DEFAULT 'active' CHECK(current_status IN ('active', 'removed'))
);

CREATE TABLE story_events (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(story_id, event_id)
);

CREATE INDEX stories_updated ON stories(updated_at);

CREATE INDEX story_events_event ON story_events(event_id);

CREATE TABLE model_facts (
  canonical_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_fact_conflicts (
  canonical_id TEXT NOT NULL,
  field TEXT NOT NULL,
  incumbent_event_id INTEGER NOT NULL REFERENCES events(id),
  challenger_event_id INTEGER NOT NULL REFERENCES events(id),
  detected_at TEXT NOT NULL,
  PRIMARY KEY(canonical_id, field, incumbent_event_id, challenger_event_id)
);

CREATE INDEX model_facts_updated
ON model_facts(updated_at);

CREATE TABLE hypotheses (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('emerging', 'strengthening', 'confirmed', 'stale')),
  independent_source_count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  formed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_event_id INTEGER REFERENCES events(id)
);

CREATE TABLE hypothesis_events (
  hypothesis_id INTEGER NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  role TEXT NOT NULL CHECK(role IN ('supporting', 'resolution')),
  PRIMARY KEY(hypothesis_id, event_id)
);

CREATE INDEX hypotheses_updated
ON hypotheses(updated_at);

CREATE INDEX hypothesis_events_event
ON hypothesis_events(event_id);

CREATE TABLE lifecycle_deadlines (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  canonical_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  deadline_type TEXT NOT NULL CHECK(deadline_type IN ('deprecation', 'retirement', 'shutdown')),
  deadline_at TEXT NOT NULL,
  replacement TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE lifecycle_reminders (
  deadline_id INTEGER NOT NULL REFERENCES lifecycle_deadlines(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  batch_id INTEGER REFERENCES batches(id),
  PRIMARY KEY(deadline_id, offset_days)
);

CREATE INDEX lifecycle_deadlines_time
ON lifecycle_deadlines(deadline_at);

CREATE INDEX lifecycle_reminders_due
ON lifecycle_reminders(due_at);

CREATE TABLE code_metrics (
  name TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  min_duration_ms INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  duration_buckets_json TEXT NOT NULL,
  last_called_at TEXT NOT NULL,
  last_error_at TEXT,
  last_error_type TEXT,
  PRIMARY KEY(name, bucket_start)
);

CREATE INDEX code_metrics_bucket_start ON code_metrics(bucket_start);

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

CREATE TABLE alert_attempts (
  id INTEGER PRIMARY KEY,
  state_version INTEGER NOT NULL UNIQUE,
  from_state_json TEXT NOT NULL,
  to_state_json TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX alert_attempts_due ON alert_attempts(status, next_attempt);

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

CREATE INDEX model_fact_fields_event ON model_fact_fields(event_id);

CREATE INDEX batch_events_signal ON batch_events(batch_id, signal);

CREATE TABLE suppressions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  destination_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (event_id, destination_id)
);

CREATE INDEX suppressions_recorded_at ON suppressions(recorded_at);

CREATE INDEX suppressions_reason ON suppressions(reason, recorded_at);

CREATE INDEX snapshots_source_hash ON snapshots(source, hash);

CREATE INDEX snapshots_collected ON snapshots(collected_at);

CREATE TRIGGER code_metrics_last_called_at_shape_insert
BEFORE INSERT ON code_metrics
WHEN NEW.last_called_at IS NOT NULL AND NEW.last_called_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_called_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER code_metrics_last_called_at_shape_update
BEFORE UPDATE OF last_called_at ON code_metrics
WHEN NEW.last_called_at IS NOT NULL AND NEW.last_called_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_called_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER code_metrics_last_error_at_shape_insert
BEFORE INSERT ON code_metrics
WHEN NEW.last_error_at IS NOT NULL AND NEW.last_error_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_error_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER code_metrics_last_error_at_shape_update
BEFORE UPDATE OF last_error_at ON code_metrics
WHEN NEW.last_error_at IS NOT NULL AND NEW.last_error_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_error_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER deepseek_usage_attempted_at_shape_insert
BEFORE INSERT ON deepseek_usage
WHEN NEW.attempted_at IS NOT NULL AND NEW.attempted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deepseek_usage.attempted_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER deepseek_usage_attempted_at_shape_update
BEFORE UPDATE OF attempted_at ON deepseek_usage
WHEN NEW.attempted_at IS NOT NULL AND NEW.attempted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deepseek_usage.attempted_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER deliveries_verified_at_shape_insert
BEFORE INSERT ON deliveries
WHEN NEW.verified_at IS NOT NULL AND NEW.verified_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deliveries.verified_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER deliveries_verified_at_shape_update
BEFORE UPDATE OF verified_at ON deliveries
WHEN NEW.verified_at IS NOT NULL AND NEW.verified_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deliveries.verified_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER events_detected_at_shape_insert
BEFORE INSERT ON events
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'events.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER events_detected_at_shape_update
BEFORE UPDATE OF detected_at ON events
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'events.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_first_seen_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON hypotheses
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_formed_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.formed_at IS NOT NULL AND NEW.formed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.formed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_formed_at_shape_update
BEFORE UPDATE OF formed_at ON hypotheses
WHEN NEW.formed_at IS NOT NULL AND NEW.formed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.formed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_updated_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_updated_at_shape_update
BEFORE UPDATE OF updated_at ON hypotheses
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_resolved_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.resolved_at IS NOT NULL AND NEW.resolved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.resolved_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER hypotheses_resolved_at_shape_update
BEFORE UPDATE OF resolved_at ON hypotheses
WHEN NEW.resolved_at IS NOT NULL AND NEW.resolved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.resolved_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_deadlines_deadline_at_shape_insert
BEFORE INSERT ON lifecycle_deadlines
WHEN NEW.deadline_at IS NOT NULL AND NEW.deadline_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.deadline_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_deadlines_deadline_at_shape_update
BEFORE UPDATE OF deadline_at ON lifecycle_deadlines
WHEN NEW.deadline_at IS NOT NULL AND NEW.deadline_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.deadline_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_deadlines_updated_at_shape_insert
BEFORE INSERT ON lifecycle_deadlines
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_deadlines_updated_at_shape_update
BEFORE UPDATE OF updated_at ON lifecycle_deadlines
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_reminders_due_at_shape_insert
BEFORE INSERT ON lifecycle_reminders
WHEN NEW.due_at IS NOT NULL AND NEW.due_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_reminders.due_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER lifecycle_reminders_due_at_shape_update
BEFORE UPDATE OF due_at ON lifecycle_reminders
WHEN NEW.due_at IS NOT NULL AND NEW.due_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_reminders.due_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_fact_conflicts_detected_at_shape_insert
BEFORE INSERT ON model_fact_conflicts
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_conflicts.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_fact_conflicts_detected_at_shape_update
BEFORE UPDATE OF detected_at ON model_fact_conflicts
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_conflicts.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_fact_fields_observed_at_shape_insert
BEFORE INSERT ON model_fact_fields
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_fields.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_fact_fields_observed_at_shape_update
BEFORE UPDATE OF observed_at ON model_fact_fields
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_fields.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_facts_first_seen_at_shape_insert
BEFORE INSERT ON model_facts
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_facts_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON model_facts
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_facts_updated_at_shape_insert
BEFORE INSERT ON model_facts
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER model_facts_updated_at_shape_update
BEFORE UPDATE OF updated_at ON model_facts
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER records_observed_at_shape_insert
BEFORE INSERT ON records
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'records.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER records_observed_at_shape_update
BEFORE UPDATE OF observed_at ON records
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'records.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER snapshots_collected_at_shape_insert
BEFORE INSERT ON snapshots
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER snapshots_collected_at_shape_update
BEFORE UPDATE OF collected_at ON snapshots
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER snapshots_expired_at_shape_insert
BEFORE INSERT ON snapshots
WHEN NEW.expired_at IS NOT NULL AND NEW.expired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.expired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER snapshots_expired_at_shape_update
BEFORE UPDATE OF expired_at ON snapshots
WHEN NEW.expired_at IS NOT NULL AND NEW.expired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.expired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER source_collection_metrics_collected_at_shape_insert
BEFORE INSERT ON source_collection_metrics
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'source_collection_metrics.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER source_collection_metrics_collected_at_shape_update
BEFORE UPDATE OF collected_at ON source_collection_metrics
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'source_collection_metrics.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_checked_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_checked_at_shape_update
BEFORE UPDATE OF checked_at ON sources
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_retry_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.retry_at IS NOT NULL AND NEW.retry_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.retry_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_retry_at_shape_update
BEFORE UPDATE OF retry_at ON sources
WHEN NEW.retry_at IS NOT NULL AND NEW.retry_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.retry_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER stories_first_seen_at_shape_insert
BEFORE INSERT ON stories
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER stories_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON stories
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER stories_updated_at_shape_insert
BEFORE INSERT ON stories
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER stories_updated_at_shape_update
BEFORE UPDATE OF updated_at ON stories
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER summaries_created_at_shape_insert
BEFORE INSERT ON summaries
WHEN NEW.created_at IS NOT NULL AND NEW.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'summaries.created_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER summaries_created_at_shape_update
BEFORE UPDATE OF created_at ON summaries
WHEN NEW.created_at IS NOT NULL AND NEW.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'summaries.created_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER suppressions_recorded_at_shape_insert
BEFORE INSERT ON suppressions
WHEN NEW.recorded_at IS NOT NULL AND NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'suppressions.recorded_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER suppressions_recorded_at_shape_update
BEFORE UPDATE OF recorded_at ON suppressions
WHEN NEW.recorded_at IS NOT NULL AND NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'suppressions.recorded_at must be an ISO-8601 UTC instant'); END;

CREATE TABLE credential_circuits (
  capability_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('open', 'cleared')),
  status_code INTEGER,
  source TEXT NOT NULL,
  detail TEXT NOT NULL,
  rejections INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL,
  last_rejected_at TEXT NOT NULL,
  cleared_at TEXT
);

CREATE TRIGGER credential_circuits_opened_at_shape_insert
BEFORE INSERT ON credential_circuits
WHEN NEW.opened_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.opened_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER credential_circuits_last_rejected_at_shape_insert
BEFORE INSERT ON credential_circuits
WHEN NEW.last_rejected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.last_rejected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER credential_circuits_last_rejected_at_shape_update
BEFORE UPDATE OF last_rejected_at ON credential_circuits
WHEN NEW.last_rejected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.last_rejected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER credential_circuits_cleared_at_shape_update
BEFORE UPDATE OF cleared_at ON credential_circuits
WHEN NEW.cleared_at IS NOT NULL AND NEW.cleared_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.cleared_at must be an ISO-8601 UTC instant'); END;

CREATE TABLE action_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER action_locks_acquired_at_shape_insert
BEFORE INSERT ON action_locks
WHEN NEW.acquired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'action_locks.acquired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER action_locks_acquired_at_shape_update
BEFORE UPDATE OF acquired_at ON action_locks
WHEN NEW.acquired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'action_locks.acquired_at must be an ISO-8601 UTC instant'); END;

CREATE TABLE operator_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('cli', 'http', 'mcp')),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'rejected', 'failed')),
  detail TEXT
);

CREATE INDEX operator_journal_recorded_at ON operator_journal(recorded_at DESC, id DESC);

CREATE TRIGGER operator_journal_recorded_at_shape_insert
BEFORE INSERT ON operator_journal
WHEN NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'operator_journal.recorded_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_failure_started_at_shape_update
BEFORE UPDATE OF failure_started_at ON sources
WHEN NEW.failure_started_at IS NOT NULL AND NEW.failure_started_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.failure_started_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER sources_failure_started_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.failure_started_at IS NOT NULL AND NEW.failure_started_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.failure_started_at must be an ISO-8601 UTC instant'); END;

CREATE TABLE publications (
  ref TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL UNIQUE,
  published_at TEXT,
  status TEXT NOT NULL,
  headline TEXT NOT NULL,
  text_ru TEXT,
  text_en TEXT,
  targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
  checked_at TEXT NOT NULL
);

CREATE INDEX publications_date ON publications(published_at);

CREATE TRIGGER publications_published_at_shape_insert
BEFORE INSERT ON publications
WHEN NEW.published_at IS NOT NULL AND NEW.published_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.published_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER publications_published_at_shape_update
BEFORE UPDATE OF published_at ON publications
WHEN NEW.published_at IS NOT NULL AND NEW.published_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.published_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER publications_checked_at_shape_insert
BEFORE INSERT ON publications
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER publications_checked_at_shape_update
BEFORE UPDATE OF checked_at ON publications
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.checked_at must be an ISO-8601 UTC instant'); END;

