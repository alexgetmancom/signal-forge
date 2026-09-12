-- A rejected credential is not a flaky network. Per-source backoff treats both the same way and
-- keeps asking; a key that was revoked answers 401 every time, and the retry is what turns one
-- rotated token into a day of failing boards and repeated alerts.
--
-- One row per capability, because the credential is what was rejected, not the source that
-- happened to carry it: three collectors sharing GITHUB_TOKEN stop together and clear together.
CREATE TABLE IF NOT EXISTS credential_circuits (
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

CREATE TRIGGER IF NOT EXISTS credential_circuits_opened_at_shape_insert
BEFORE INSERT ON credential_circuits
WHEN NEW.opened_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.opened_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS credential_circuits_last_rejected_at_shape_insert
BEFORE INSERT ON credential_circuits
WHEN NEW.last_rejected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.last_rejected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS credential_circuits_last_rejected_at_shape_update
BEFORE UPDATE OF last_rejected_at ON credential_circuits
WHEN NEW.last_rejected_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.last_rejected_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS credential_circuits_cleared_at_shape_update
BEFORE UPDATE OF cleared_at ON credential_circuits
WHEN NEW.cleared_at IS NOT NULL AND NEW.cleared_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'credential_circuits.cleared_at must be an ISO-8601 UTC instant'); END;
