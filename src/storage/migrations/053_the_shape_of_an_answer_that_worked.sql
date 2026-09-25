-- What an upstream answer looked like while it still worked.
--
-- Diagnosing `arena` on 2026-09-25 needed a live fetch of the page, because nothing stored could
-- say what `initialModels` used to be. The body of a failed parse is deliberately never kept -- it
-- is somebody else's data, and one of the bodies seen that day carried a signed URL -- so the only
-- comparison available was against a guess. A shape is the other half: the paths and the types of
-- a successful answer, with no value in it anywhere, so "the response changed" becomes a diff.
--
-- One row per distinct shape per source, not one per collection: a contract that holds produces the
-- same hash every hour and bumps a counter. The counts are separate from the hash on purpose. A
-- roster of 61 models and a roster of 1,083 are the same contract, and the three sizes `arena`
-- returned are the question that could not be asked at all before this.
CREATE TABLE IF NOT EXISTS source_shapes (
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

CREATE INDEX IF NOT EXISTS source_shapes_recent ON source_shapes(source, last_seen_at DESC);

ANALYZE;
