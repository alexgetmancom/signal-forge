/**
 * Every stored instant is an ISO-8601 UTC string, and the database enforces the shape. A
 * well-formed instant in the wrong zone is the failure this exists for: `new Date("Aug 20, 2026")`
 * resolves in the host's timezone, so the same import run on two machines dates the same evidence
 * two different days, and nothing downstream can tell which one is right.
 *
 * This list is the one place the columns are named. The migration's triggers are generated from
 * it, `dateIntegrity()` scans from it, and a test fails when the schema grows a timestamp column
 * that is not here.
 */
export const TIMESTAMP_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ["code_metrics", "last_called_at"],
  ["code_metrics", "last_error_at"],
  ["deepseek_usage", "attempted_at"],
  ["deliveries", "verified_at"],
  ["events", "detected_at"],
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
 * `YYYY-MM-DDTHH:MM:SS`, optional fractional seconds, and a literal `Z`. GLOB is SQLite's only
 * pattern operator that distinguishes digits from other characters, so the trailing `*Z` is what
 * keeps a local-time string with an offset out.
 */
export const TIMESTAMP_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z";
