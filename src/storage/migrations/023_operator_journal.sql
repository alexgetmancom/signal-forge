-- Two things an operator cannot reconstruct afterwards.
--
-- A lock, so one collection cycle runs at a time: `poll` from the CLI and the source worker are
-- two processes against one database file, and a source collected twice in the same second
-- produces evidence that disagrees with itself.
CREATE TABLE IF NOT EXISTS action_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS action_locks_acquired_at_shape_insert
BEFORE INSERT ON action_locks
WHEN NEW.acquired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'action_locks.acquired_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS action_locks_acquired_at_shape_update
BEFORE UPDATE OF acquired_at ON action_locks
WHEN NEW.acquired_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'action_locks.acquired_at must be an ISO-8601 UTC instant'); END;

-- And a journal, because a delivery whose outcome was decided by hand is the one case where the
-- database cannot say why it holds what it holds. "Did anyone already verify this, and what did
-- they see?" has no other answer.
CREATE TABLE IF NOT EXISTS operator_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('cli', 'http', 'mcp')),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'rejected', 'failed')),
  detail TEXT
);

CREATE INDEX IF NOT EXISTS operator_journal_recorded_at ON operator_journal(recorded_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS operator_journal_recorded_at_shape_insert
BEFORE INSERT ON operator_journal
WHEN NEW.recorded_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'operator_journal.recorded_at must be an ISO-8601 UTC instant'); END;
