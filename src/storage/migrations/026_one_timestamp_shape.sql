-- One shape for every stored instant, and one place that says so.
--
-- The shape is also exact now, where 001 allowed the fractional seconds to be missing. Two
-- spellings of one instant sort against each other the wrong way round - '...:00Z' is greater than
-- '...:00.000Z', because 'Z' is greater than '.' - and these columns are compared as text to decide
-- when a batch is due and when a retry may happen. `toISOString()` always writes the three digits;
-- the constraint now says so.
--
-- 001 enforced the ISO-8601 UTC shape with a pair of triggers per column: sixty-five of them, half the
-- schema file, all carrying the same GLOB. A CHECK constraint says the same thing in the column
-- definition and covers INSERT and UPDATE at once, so the triggers are gone and the rule is read
-- where the column is declared. The pairs had also drifted - `credential_circuits`, `action_locks`
-- and `operator_journal` carried triggers nothing scanned, and `action_locks.expires_at` was
-- guarded by neither.
--
-- The other half of the drift was representation: batches, deliveries, alerts and the HTTP cache
-- stored their instants as epoch milliseconds, so exactly the columns that schedule a retry were
-- the ones no shape rule could reach. They are ISO-8601 UTC text now, which compares in the same
-- order it sorts, and the three columns that were instants without saying so are named `_at` like
-- every other one.
--
-- Also here, because each one is a duplicate the schema was carrying:
--   * `snapshots.raw_json` - written empty and read by nothing since payloads became compressed
--     blobs in `body`. Run scripts/compress-snapshots.ts before this migration.
--   * `change_candidates` - a second table keyed exactly like `records`, holding one pending body
--     and a counter that was only ever 1. It is a column on `records` now.
--   * `deliveries.destination_json` - a verbatim copy of the `batch_targets` row the delivery was
--     built from, refreshed from it on every write. A foreign key reaches the original.
--   * `publications.text_ru` - the archive keeps the English copy only.
--   * `events(source, id)` - an index on the primary key with a prefix nothing queries by, while
--     every real query filters on stream and detected_at.
--   * `suppressions(reason, recorded_at)` - a second index on a table whose every query is a
--     window of time and none of which filters by reason.
--
-- Tables are rebuilt by the rename-copy-drop route, which the migration runner makes safe by
-- turning foreign key enforcement off around the transaction and asking `foreign_key_check` inside
-- it whether anything ended up orphaned.

DROP TRIGGER code_metrics_last_called_at_shape_insert;
DROP TRIGGER code_metrics_last_called_at_shape_update;
DROP TRIGGER code_metrics_last_error_at_shape_insert;
DROP TRIGGER code_metrics_last_error_at_shape_update;
DROP TRIGGER deepseek_usage_attempted_at_shape_insert;
DROP TRIGGER deepseek_usage_attempted_at_shape_update;
DROP TRIGGER deliveries_verified_at_shape_insert;
DROP TRIGGER deliveries_verified_at_shape_update;
DROP TRIGGER events_detected_at_shape_insert;
DROP TRIGGER events_detected_at_shape_update;
DROP TRIGGER hypotheses_first_seen_at_shape_insert;
DROP TRIGGER hypotheses_first_seen_at_shape_update;
DROP TRIGGER hypotheses_formed_at_shape_insert;
DROP TRIGGER hypotheses_formed_at_shape_update;
DROP TRIGGER hypotheses_updated_at_shape_insert;
DROP TRIGGER hypotheses_updated_at_shape_update;
DROP TRIGGER hypotheses_resolved_at_shape_insert;
DROP TRIGGER hypotheses_resolved_at_shape_update;
DROP TRIGGER lifecycle_deadlines_deadline_at_shape_insert;
DROP TRIGGER lifecycle_deadlines_deadline_at_shape_update;
DROP TRIGGER lifecycle_deadlines_updated_at_shape_insert;
DROP TRIGGER lifecycle_deadlines_updated_at_shape_update;
DROP TRIGGER lifecycle_reminders_due_at_shape_insert;
DROP TRIGGER lifecycle_reminders_due_at_shape_update;
DROP TRIGGER model_fact_conflicts_detected_at_shape_insert;
DROP TRIGGER model_fact_conflicts_detected_at_shape_update;
DROP TRIGGER model_fact_fields_observed_at_shape_insert;
DROP TRIGGER model_fact_fields_observed_at_shape_update;
DROP TRIGGER model_facts_first_seen_at_shape_insert;
DROP TRIGGER model_facts_first_seen_at_shape_update;
DROP TRIGGER model_facts_updated_at_shape_insert;
DROP TRIGGER model_facts_updated_at_shape_update;
DROP TRIGGER records_observed_at_shape_insert;
DROP TRIGGER records_observed_at_shape_update;
DROP TRIGGER snapshots_collected_at_shape_insert;
DROP TRIGGER snapshots_collected_at_shape_update;
DROP TRIGGER snapshots_expired_at_shape_insert;
DROP TRIGGER snapshots_expired_at_shape_update;
DROP TRIGGER source_collection_metrics_collected_at_shape_insert;
DROP TRIGGER source_collection_metrics_collected_at_shape_update;
DROP TRIGGER sources_checked_at_shape_insert;
DROP TRIGGER sources_checked_at_shape_update;
DROP TRIGGER sources_retry_at_shape_insert;
DROP TRIGGER sources_retry_at_shape_update;
DROP TRIGGER sources_failure_started_at_shape_insert;
DROP TRIGGER sources_failure_started_at_shape_update;
DROP TRIGGER stories_first_seen_at_shape_insert;
DROP TRIGGER stories_first_seen_at_shape_update;
DROP TRIGGER stories_updated_at_shape_insert;
DROP TRIGGER stories_updated_at_shape_update;
DROP TRIGGER summaries_created_at_shape_insert;
DROP TRIGGER summaries_created_at_shape_update;
DROP TRIGGER suppressions_recorded_at_shape_insert;
DROP TRIGGER suppressions_recorded_at_shape_update;
DROP TRIGGER credential_circuits_opened_at_shape_insert;
DROP TRIGGER credential_circuits_last_rejected_at_shape_insert;
DROP TRIGGER credential_circuits_last_rejected_at_shape_update;
DROP TRIGGER credential_circuits_cleared_at_shape_update;
DROP TRIGGER action_locks_acquired_at_shape_insert;
DROP TRIGGER action_locks_acquired_at_shape_update;
DROP TRIGGER operator_journal_recorded_at_shape_insert;
DROP TRIGGER publications_published_at_shape_insert;
DROP TRIGGER publications_published_at_shape_update;
DROP TRIGGER publications_checked_at_shape_insert;
DROP TRIGGER publications_checked_at_shape_update;

-- sources

ALTER TABLE sources RENAME TO sources_old;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  checked_at TEXT CHECK(checked_at IS NULL OR checked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT CHECK(retry_at IS NULL OR retry_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failure_started_at TEXT CHECK(failure_started_at IS NULL OR failure_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO sources SELECT id,last_success,last_error,checked_at,failures,retry_at,failure_started_at FROM sources_old;
DROP TABLE sources_old;

-- snapshots: the payload lives in `body`, compressed, and `raw_json` is gone.

ALTER TABLE snapshots RENAME TO snapshots_old;
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL CHECK(collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  body BLOB,
  hash TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  expired_at TEXT CHECK(expired_at IS NULL OR expired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO snapshots SELECT id,source,collected_at,body,hash,bytes,expired_at FROM snapshots_old;
DROP TABLE snapshots_old;
CREATE INDEX snapshots_source_hash ON snapshots(source, hash);
CREATE INDEX snapshots_collected ON snapshots(collected_at);

-- records: a pending change waiting for its second sighting is a column here, not a table.

ALTER TABLE records RENAME TO records_old;
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
INSERT INTO records
SELECT r.source,r.id,r.body,r.missing_count,r.stream,r.observed_at,
       (SELECT c.body FROM change_candidates c WHERE c.source=r.source AND c.id=r.id)
FROM records_old r;
DROP TABLE records_old;
DROP TABLE change_candidates;

-- events

ALTER TABLE events RENAME TO events_old;
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
INSERT INTO events SELECT id,source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id,confidence,evidence_type,authority FROM events_old;
DROP TABLE events_old;
-- What every reader actually asks for: one stream over a window of time.
CREATE INDEX events_stream_time ON events(stream, detected_at);

-- batches: ready_at was epoch milliseconds.

ALTER TABLE batches RENAME TO batches_old;
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL CHECK(ready_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sealed INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event'
    CHECK(kind IN ('event', 'lifecycle_reminder')),
  context_json TEXT
);
INSERT INTO batches
SELECT id,source,digest,strftime('%Y-%m-%dT%H:%M:%fZ', ready_at / 1000.0, 'unixepoch'),sealed,kind,context_json FROM batches_old;
DROP TABLE batches_old;

-- summaries

ALTER TABLE summaries RENAME TO summaries_old;
CREATE TABLE summaries (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO summaries SELECT event_id,text,created_at FROM summaries_old;
DROP TABLE summaries_old;

-- http_cache: both instants were epoch milliseconds, and one of them did not say it was an instant.

ALTER TABLE http_cache RENAME TO http_cache_old;
CREATE TABLE http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fresh_until_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(fresh_until_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  body TEXT NOT NULL,
  used_at TEXT NOT NULL CHECK(used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO http_cache
SELECT url,etag,last_modified,
       strftime('%Y-%m-%dT%H:%M:%fZ', fresh_until / 1000.0, 'unixepoch'),
       body,
       strftime('%Y-%m-%dT%H:%M:%fZ', used_at / 1000.0, 'unixepoch')
FROM http_cache_old;
DROP TABLE http_cache_old;

-- deliveries: the retry clock and the send clock were epoch milliseconds beside an ISO column.

ALTER TABLE deliveries RENAME TO deliveries_old;
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
INSERT INTO deliveries
SELECT id,batch_id,destination_id,destination_json,body,part,status,attempts,
       strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt / 1000.0, 'unixepoch'),
       external_id,error,
       strftime('%Y-%m-%dT%H:%M:%fZ', updated_at / 1000.0, 'unixepoch'),
       verification_source,verified_at,verification_attempts,last_verification_error
FROM deliveries_old;
DROP TABLE deliveries_old;
CREATE INDEX deliveries_pending ON deliveries(status, next_attempt_at);

-- source_collection_metrics

ALTER TABLE source_collection_metrics RENAME TO source_collection_metrics_old;
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
  error TEXT
);
INSERT INTO source_collection_metrics SELECT id,source,collected_at,success,records_processed,events_created,new_events,changed_events,removed_events,error FROM source_collection_metrics_old;
DROP TABLE source_collection_metrics_old;
CREATE INDEX source_collection_metrics_source_time ON source_collection_metrics(source, collected_at);

-- stories

ALTER TABLE stories RENAME TO stories_old;
CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  vendor TEXT NOT NULL,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  current_status TEXT NOT NULL DEFAULT 'active' CHECK(current_status IN ('active', 'removed'))
);
INSERT INTO stories SELECT id,stable_key,title,normalized_subject,vendor,first_seen_at,updated_at,confidence,current_status FROM stories_old;
DROP TABLE stories_old;
CREATE INDEX stories_updated ON stories(updated_at);

-- model_facts

ALTER TABLE model_facts RENAME TO model_facts_old;
CREATE TABLE model_facts (
  canonical_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL CHECK(first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO model_facts SELECT canonical_id,first_seen_at,updated_at FROM model_facts_old;
DROP TABLE model_facts_old;
CREATE INDEX model_facts_updated ON model_facts(updated_at);

-- model_fact_conflicts

ALTER TABLE model_fact_conflicts RENAME TO model_fact_conflicts_old;
CREATE TABLE model_fact_conflicts (
  canonical_id TEXT NOT NULL,
  field TEXT NOT NULL,
  incumbent_event_id INTEGER NOT NULL REFERENCES events(id),
  challenger_event_id INTEGER NOT NULL REFERENCES events(id),
  detected_at TEXT NOT NULL CHECK(detected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY(canonical_id, field, incumbent_event_id, challenger_event_id)
);
INSERT INTO model_fact_conflicts SELECT canonical_id,field,incumbent_event_id,challenger_event_id,detected_at FROM model_fact_conflicts_old;
DROP TABLE model_fact_conflicts_old;

-- model_fact_fields

ALTER TABLE model_fact_fields RENAME TO model_fact_fields_old;
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
INSERT INTO model_fact_fields SELECT canonical_id,field,value_json,confidence,evidence_type,source,event_id,observed_at FROM model_fact_fields_old;
DROP TABLE model_fact_fields_old;
CREATE INDEX model_fact_fields_event ON model_fact_fields(event_id);

-- hypotheses

ALTER TABLE hypotheses RENAME TO hypotheses_old;
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
INSERT INTO hypotheses SELECT id,stable_key,story_id,subject,status,independent_source_count,first_seen_at,formed_at,updated_at,resolved_at,resolution_event_id FROM hypotheses_old;
DROP TABLE hypotheses_old;
CREATE INDEX hypotheses_updated ON hypotheses(updated_at);

-- lifecycle_deadlines

ALTER TABLE lifecycle_deadlines RENAME TO lifecycle_deadlines_old;
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
INSERT INTO lifecycle_deadlines SELECT id,stable_key,event_id,canonical_id,title,source,deadline_type,deadline_at,replacement,active,updated_at FROM lifecycle_deadlines_old;
DROP TABLE lifecycle_deadlines_old;
CREATE INDEX lifecycle_deadlines_time ON lifecycle_deadlines(deadline_at);

-- lifecycle_reminders

ALTER TABLE lifecycle_reminders RENAME TO lifecycle_reminders_old;
CREATE TABLE lifecycle_reminders (
  deadline_id INTEGER NOT NULL REFERENCES lifecycle_deadlines(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  due_at TEXT NOT NULL CHECK(due_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  batch_id INTEGER REFERENCES batches(id),
  PRIMARY KEY(deadline_id, offset_days)
);
INSERT INTO lifecycle_reminders SELECT deadline_id,offset_days,due_at,batch_id FROM lifecycle_reminders_old;
DROP TABLE lifecycle_reminders_old;
CREATE INDEX lifecycle_reminders_due ON lifecycle_reminders(due_at);

-- code_metrics

ALTER TABLE code_metrics RENAME TO code_metrics_old;
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
  PRIMARY KEY(name, bucket_start)
);
INSERT INTO code_metrics SELECT name,bucket_start,calls,failures,total_duration_ms,min_duration_ms,max_duration_ms,duration_buckets_json,last_called_at,last_error_at,last_error_type FROM code_metrics_old;
DROP TABLE code_metrics_old;
CREATE INDEX code_metrics_bucket_start ON code_metrics(bucket_start);

-- deepseek_usage

ALTER TABLE deepseek_usage RENAME TO deepseek_usage_old;
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
  error_type TEXT
);
INSERT INTO deepseek_usage SELECT id,event_id,attempted_at,operation,source,stream,model,attempts,input_chars,response_status,outcome,prompt_tokens,completion_tokens,total_tokens,prompt_cache_hit_tokens,prompt_cache_miss_tokens,cost_usd,cost_basis,pricing_period,error_type FROM deepseek_usage_old;
DROP TABLE deepseek_usage_old;
CREATE UNIQUE INDEX deepseek_usage_event ON deepseek_usage(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX deepseek_usage_attempted_at ON deepseek_usage(attempted_at);
CREATE INDEX deepseek_usage_operation ON deepseek_usage(operation, attempted_at);

-- alert_attempts: three epoch columns, one of them a retry clock that did not say it was a time.

ALTER TABLE alert_attempts RENAME TO alert_attempts_old;
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
INSERT INTO alert_attempts
SELECT id,state_version,from_state_json,to_state_json,body,status,attempts,
       strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt / 1000.0, 'unixepoch'),
       error,
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch'),
       strftime('%Y-%m-%dT%H:%M:%fZ', updated_at / 1000.0, 'unixepoch')
FROM alert_attempts_old;
DROP TABLE alert_attempts_old;
CREATE INDEX alert_attempts_due ON alert_attempts(status, next_attempt_at);

-- suppressions

ALTER TABLE suppressions RENAME TO suppressions_old;
CREATE TABLE suppressions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  destination_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (event_id, destination_id)
);
INSERT INTO suppressions SELECT event_id,destination_id,batch_id,reason,detail,recorded_at FROM suppressions_old;
DROP TABLE suppressions_old;
-- Every suppression query is a window of time; none of them filters by reason.
CREATE INDEX suppressions_recorded_at ON suppressions(recorded_at);

-- credential_circuits

ALTER TABLE credential_circuits RENAME TO credential_circuits_old;
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
INSERT INTO credential_circuits SELECT capability_id,state,status_code,source,detail,rejections,opened_at,last_rejected_at,cleared_at FROM credential_circuits_old;
DROP TABLE credential_circuits_old;

-- action_locks: `expires_at` was guarded by nothing at all.

ALTER TABLE action_locks RENAME TO action_locks_old;
CREATE TABLE action_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL CHECK(acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
INSERT INTO action_locks SELECT name,holder,acquired_at,expires_at FROM action_locks_old;
DROP TABLE action_locks_old;

-- operator_journal: the only AUTOINCREMENT in the schema, and the only reason for sqlite_sequence.

ALTER TABLE operator_journal RENAME TO operator_journal_old;
CREATE TABLE operator_journal (
  id INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  surface TEXT NOT NULL CHECK(surface IN ('cli', 'http', 'mcp')),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'rejected', 'failed')),
  detail TEXT
);
INSERT INTO operator_journal SELECT id,recorded_at,surface,operation,input_json,outcome,detail FROM operator_journal_old;
DROP TABLE operator_journal_old;
CREATE INDEX operator_journal_recorded_at ON operator_journal(recorded_at DESC, id DESC);

-- publications: the archive keeps the English copy.

ALTER TABLE publications RENAME TO publications_old;
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
INSERT INTO publications SELECT ref,post_id,published_at,status,headline,text_en,targets_json,checked_at FROM publications_old;
DROP TABLE publications_old;
CREATE INDEX publications_date ON publications(published_at);
