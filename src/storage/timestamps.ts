/**
 * Every stored instant is an ISO-8601 UTC string, and the database enforces the shape. A
 * well-formed instant in the wrong zone is the failure this exists for: `new Date("Aug 20, 2026")`
 * resolves in the host's timezone, so the same import run on two machines dates the same evidence
 * two different days, and nothing downstream can tell which one is right.
 *
 * This list is the one place the columns are named. Each one carries a CHECK constraint in its own
 * declaration, `dateIntegrity()` scans from here, and a test fails when the schema grows a
 * timestamp column that this list or that constraint has missed.
 */
export const TIMESTAMP_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ["action_locks", "acquired_at"],
  ["action_locks", "expires_at"],
  ["alert_attempts", "next_attempt_at"],
  ["alert_attempts", "created_at"],
  ["alert_attempts", "updated_at"],
  ["batches", "ready_at"],
  ["code_metrics", "last_called_at"],
  ["code_metrics", "last_error_at"],
  ["credential_circuits", "opened_at"],
  ["credential_circuits", "last_rejected_at"],
  ["credential_circuits", "cleared_at"],
  ["deepseek_usage", "attempted_at"],
  ["deliveries", "next_attempt_at"],
  ["deliveries", "updated_at"],
  ["deliveries", "verified_at"],
  ["events", "detected_at"],
  ["http_cache", "fresh_until_at"],
  ["http_cache", "used_at"],
  ["hypotheses", "first_seen_at"],
  ["hypotheses", "formed_at"],
  ["hypotheses", "updated_at"],
  ["hypotheses", "resolved_at"],
  ["lifecycle_deadlines", "deadline_at"],
  ["lifecycle_deadlines", "updated_at"],
  ["lifecycle_reminders", "due_at"],
  ["model_fact_conflicts", "detected_at"],
  ["model_fact_fields", "observed_at"],
  ["model_facts", "first_seen_at"],
  ["model_facts", "updated_at"],
  ["operator_journal", "recorded_at"],
  ["publications", "published_at"],
  ["publications", "checked_at"],
  ["records", "observed_at"],
  ["snapshots", "collected_at"],
  ["snapshots", "expired_at"],
  ["source_collection_metrics", "collected_at"],
  ["sources", "checked_at"],
  ["sources", "failure_started_at"],
  ["sources", "retry_at"],
  ["stories", "first_seen_at"],
  ["stories", "updated_at"],
  ["summaries", "created_at"],
  ["suppressions", "recorded_at"],
];

/**
 * `YYYY-MM-DDTHH:MM:SS.mmmZ`, exactly - what `toISOString()` writes and nothing else. GLOB is
 * SQLite's only pattern operator that distinguishes digits from other characters, and the literal
 * `Z` is what keeps a local-time string with an offset out.
 *
 * The three fractional digits are not decoration. These columns are compared as text to decide
 * when a batch is due and when a retry may happen, and an instant written without them sorts
 * after the same instant written with them, because `Z` is greater than `.`.
 */
export const TIMESTAMP_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";
