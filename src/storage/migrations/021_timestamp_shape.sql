-- Timestamps are UTC, and the database says so. A shape check cannot see a wrong moment, but it
-- stops the shapes that carry one: a local-time string, an offset that is not Z, a bare date.
-- Generated from TIMESTAMP_COLUMNS in src/storage/timestamps.ts; a test keeps the two in step.

CREATE TRIGGER IF NOT EXISTS code_metrics_last_called_at_shape_insert
BEFORE INSERT ON code_metrics
WHEN NEW.last_called_at IS NOT NULL AND NEW.last_called_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_called_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS code_metrics_last_called_at_shape_update
BEFORE UPDATE OF last_called_at ON code_metrics
WHEN NEW.last_called_at IS NOT NULL AND NEW.last_called_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_called_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS code_metrics_last_error_at_shape_insert
BEFORE INSERT ON code_metrics
WHEN NEW.last_error_at IS NOT NULL AND NEW.last_error_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_error_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS code_metrics_last_error_at_shape_update
BEFORE UPDATE OF last_error_at ON code_metrics
WHEN NEW.last_error_at IS NOT NULL AND NEW.last_error_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'code_metrics.last_error_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS deepseek_usage_attempted_at_shape_insert
BEFORE INSERT ON deepseek_usage
WHEN NEW.attempted_at IS NOT NULL AND NEW.attempted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deepseek_usage.attempted_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS deepseek_usage_attempted_at_shape_update
BEFORE UPDATE OF attempted_at ON deepseek_usage
WHEN NEW.attempted_at IS NOT NULL AND NEW.attempted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deepseek_usage.attempted_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS deliveries_verified_at_shape_insert
BEFORE INSERT ON deliveries
WHEN NEW.verified_at IS NOT NULL AND NEW.verified_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deliveries.verified_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS deliveries_verified_at_shape_update
BEFORE UPDATE OF verified_at ON deliveries
WHEN NEW.verified_at IS NOT NULL AND NEW.verified_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'deliveries.verified_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS events_detected_at_shape_insert
BEFORE INSERT ON events
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'events.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS events_detected_at_shape_update
BEFORE UPDATE OF detected_at ON events
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'events.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_first_seen_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON hypotheses
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_formed_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.formed_at IS NOT NULL AND NEW.formed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.formed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_formed_at_shape_update
BEFORE UPDATE OF formed_at ON hypotheses
WHEN NEW.formed_at IS NOT NULL AND NEW.formed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.formed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_updated_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_updated_at_shape_update
BEFORE UPDATE OF updated_at ON hypotheses
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_resolved_at_shape_insert
BEFORE INSERT ON hypotheses
WHEN NEW.resolved_at IS NOT NULL AND NEW.resolved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.resolved_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS hypotheses_resolved_at_shape_update
BEFORE UPDATE OF resolved_at ON hypotheses
WHEN NEW.resolved_at IS NOT NULL AND NEW.resolved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'hypotheses.resolved_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_deadlines_deadline_at_shape_insert
BEFORE INSERT ON lifecycle_deadlines
WHEN NEW.deadline_at IS NOT NULL AND NEW.deadline_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.deadline_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_deadlines_deadline_at_shape_update
BEFORE UPDATE OF deadline_at ON lifecycle_deadlines
WHEN NEW.deadline_at IS NOT NULL AND NEW.deadline_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.deadline_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_deadlines_updated_at_shape_insert
BEFORE INSERT ON lifecycle_deadlines
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_deadlines_updated_at_shape_update
BEFORE UPDATE OF updated_at ON lifecycle_deadlines
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_deadlines.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_reminders_due_at_shape_insert
BEFORE INSERT ON lifecycle_reminders
WHEN NEW.due_at IS NOT NULL AND NEW.due_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_reminders.due_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS lifecycle_reminders_due_at_shape_update
BEFORE UPDATE OF due_at ON lifecycle_reminders
WHEN NEW.due_at IS NOT NULL AND NEW.due_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'lifecycle_reminders.due_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_fact_conflicts_detected_at_shape_insert
BEFORE INSERT ON model_fact_conflicts
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_conflicts.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_fact_conflicts_detected_at_shape_update
BEFORE UPDATE OF detected_at ON model_fact_conflicts
WHEN NEW.detected_at IS NOT NULL AND NEW.detected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_conflicts.detected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_fact_fields_observed_at_shape_insert
BEFORE INSERT ON model_fact_fields
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_fields.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_fact_fields_observed_at_shape_update
BEFORE UPDATE OF observed_at ON model_fact_fields
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_fact_fields.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_facts_first_seen_at_shape_insert
BEFORE INSERT ON model_facts
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_facts_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON model_facts
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_facts_updated_at_shape_insert
BEFORE INSERT ON model_facts
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS model_facts_updated_at_shape_update
BEFORE UPDATE OF updated_at ON model_facts
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'model_facts.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS records_observed_at_shape_insert
BEFORE INSERT ON records
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'records.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS records_observed_at_shape_update
BEFORE UPDATE OF observed_at ON records
WHEN NEW.observed_at IS NOT NULL AND NEW.observed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'records.observed_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS snapshots_collected_at_shape_insert
BEFORE INSERT ON snapshots
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS snapshots_collected_at_shape_update
BEFORE UPDATE OF collected_at ON snapshots
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS snapshots_expired_at_shape_insert
BEFORE INSERT ON snapshots
WHEN NEW.expired_at IS NOT NULL AND NEW.expired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.expired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS snapshots_expired_at_shape_update
BEFORE UPDATE OF expired_at ON snapshots
WHEN NEW.expired_at IS NOT NULL AND NEW.expired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'snapshots.expired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS source_collection_metrics_collected_at_shape_insert
BEFORE INSERT ON source_collection_metrics
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'source_collection_metrics.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS source_collection_metrics_collected_at_shape_update
BEFORE UPDATE OF collected_at ON source_collection_metrics
WHEN NEW.collected_at IS NOT NULL AND NEW.collected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'source_collection_metrics.collected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS sources_checked_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS sources_checked_at_shape_update
BEFORE UPDATE OF checked_at ON sources
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS sources_retry_at_shape_insert
BEFORE INSERT ON sources
WHEN NEW.retry_at IS NOT NULL AND NEW.retry_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.retry_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS sources_retry_at_shape_update
BEFORE UPDATE OF retry_at ON sources
WHEN NEW.retry_at IS NOT NULL AND NEW.retry_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'sources.retry_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS stories_first_seen_at_shape_insert
BEFORE INSERT ON stories
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS stories_first_seen_at_shape_update
BEFORE UPDATE OF first_seen_at ON stories
WHEN NEW.first_seen_at IS NOT NULL AND NEW.first_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.first_seen_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS stories_updated_at_shape_insert
BEFORE INSERT ON stories
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS stories_updated_at_shape_update
BEFORE UPDATE OF updated_at ON stories
WHEN NEW.updated_at IS NOT NULL AND NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'stories.updated_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS summaries_created_at_shape_insert
BEFORE INSERT ON summaries
WHEN NEW.created_at IS NOT NULL AND NEW.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'summaries.created_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS summaries_created_at_shape_update
BEFORE UPDATE OF created_at ON summaries
WHEN NEW.created_at IS NOT NULL AND NEW.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'summaries.created_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS suppressions_recorded_at_shape_insert
BEFORE INSERT ON suppressions
WHEN NEW.recorded_at IS NOT NULL AND NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'suppressions.recorded_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS suppressions_recorded_at_shape_update
BEFORE UPDATE OF recorded_at ON suppressions
WHEN NEW.recorded_at IS NOT NULL AND NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'suppressions.recorded_at must be an ISO-8601 UTC instant'); END;
