-- A model id compiled into a client the maker publishes is its own kind of evidence.
--
-- The three bundle readers -- Claude Code, the Gemini CLI, Qwen Code -- were declared as vendor
-- repositories because that was the nearest kind that existed, so every card they produced was
-- described in words written for a commit: "From the project's repository. Work in progress, not a
-- release.", and under it "Repository activity is not a release." Neither is true of them. They
-- read no repository. They download the published tarball and scan the built binary, which is the
-- maker having shipped the name to every user of the client -- stronger than a commit, and weaker
-- than a catalogue, which is the maker saying the model can be called. `claude-sonnet-5-5` went out
-- on 2026-09-28 carrying both sentences, one of them twice, and neither describing what happened.
--
-- So the evidence type is its own: `binary_string`. Nothing is rewritten -- the events already sent
-- keep the type that was true when they were sent -- and the CHECK is widened so the new one can be
-- stored at all. SQLite cannot widen a CHECK in place. 064 declined to rebuild `events` for the
-- opposite case, narrowing one to forbid a value no writer could produce; here the rebuild is what
-- makes the value writable, so there is no version of this that skips it. The runner already holds
-- foreign_keys=OFF, legacy_alter_table=ON and one transaction, which is what makes the rename safe
-- for the three tables that reference events(id).

CREATE TABLE events_rebuilt (
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
    'binary_string',
    'package_release',
    'open_weights',
    'status_page',
    'deprecation',
    'unknown'
    )),
  authority TEXT NOT NULL DEFAULT 'third_party'
    CHECK(authority IN ('first_party', 'vendor_owned', 'third_party')),
  signal TEXT,
  speaks INTEGER CHECK(speaks IS NULL OR speaks IN (0,1))
);

INSERT INTO events_rebuilt
  SELECT id, source, stream, entity_id, kind, before_json, after_json, detected_at, snapshot_id,
         confidence, evidence_type, authority, signal, speaks
  FROM events;

DROP TABLE events;
ALTER TABLE events_rebuilt RENAME TO events;

CREATE INDEX events_stream_time ON events(stream, detected_at);
CREATE INDEX events_snapshot ON events(snapshot_id);
CREATE INDEX events_detected_at ON events(detected_at);
CREATE INDEX events_source_entity ON events(source, entity_id, id);

CREATE TABLE sources_rebuilt (
  id TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  checked_at TEXT CHECK(checked_at IS NULL OR checked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT CHECK(retry_at IS NULL OR retry_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failure_started_at TEXT CHECK(failure_started_at IS NULL OR failure_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  authority TEXT
    CHECK(authority IS NULL OR authority IN ('first_party', 'vendor_owned', 'third_party')),
  vendor TEXT,
  accept_shrink INTEGER NOT NULL DEFAULT 0,
  last_error_kind TEXT,
  first_observed_at TEXT CHECK(first_observed_at IS NULL OR first_observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  evidence_type TEXT
    CHECK(evidence_type IS NULL OR evidence_type IN (
      'api_catalogue', 'availability_catalogue', 'official_news', 'arena_roster', 'leaderboard',
      'web_diff', 'github_activity', 'binary_string', 'package_release', 'open_weights',
      'status_page', 'deprecation', 'unknown'
    )),
  confidence TEXT CHECK(confidence IS NULL OR confidence IN ('observed', 'supported', 'confirmed'))
);

INSERT INTO sources_rebuilt
  SELECT id, last_success, last_error, checked_at, failures, retry_at, failure_started_at,
         authority, vendor, accept_shrink, last_error_kind, first_observed_at, evidence_type,
         confidence
  FROM sources;

DROP TABLE sources;
ALTER TABLE sources_rebuilt RENAME TO sources;

-- Two tables rebuilt: every stored distribution the planner had for them describes a table that no
-- longer exists, and until this runs a new index on either is indistinguishable from a missing one.
ANALYZE;
