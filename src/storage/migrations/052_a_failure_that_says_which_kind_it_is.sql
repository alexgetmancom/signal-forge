-- A failure kept its sentence and threw away its diagnosis.
--
-- `sources.last_error` and `source_collection_metrics.error` hold one line of prose, and the poller
-- decided whether that line was safe to store by matching a regular expression against its first
-- word. Two consequences, both measured on production 2026-09-25. `arena` failed 30 of 178 attempts
-- with "response did not match the schema (ZodError)" and nothing else: the body of a failed parse
-- is never stored, so which of its 1,083 entries broke was unknowable. And `flaky` read a 58% rate
-- for the same source while 84 of those 103 failures were this service's own shrink guard refusing a
-- short answer -- working exactly as designed, and counted as a fault.
--
-- The kind is now carried on the error and written down next to the sentence, so a rate can be read
-- per kind and the guard can be told apart from the upstream.

ALTER TABLE sources ADD COLUMN last_error_kind TEXT;
ALTER TABLE source_collection_metrics ADD COLUMN failure_kind TEXT;

CREATE INDEX IF NOT EXISTS source_collection_metrics_failures
  ON source_collection_metrics(source, collected_at) WHERE success = 0;

-- Structure only: field names from the schemas in this repository, counts, and statuses. Never an
-- upstream value, which is the reason the body is not kept in the first place.
CREATE TABLE IF NOT EXISTS source_failure_evidence (
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  kind TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (source, observed_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS source_failure_evidence_recent ON source_failure_evidence(source, observed_at DESC);

ANALYZE;
