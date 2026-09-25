-- What the build that is running renders, so a deploy can be asked whether it changed a card.
--
-- `rehearse` answers that question before a push, on a laptop, against a copy: every event in a
-- window rendered at both detail levels, reduced to one sha256. Nothing carried the answer to the
-- other side. `verify` could say the image is new -- the symbol is in /app/dist -- and could not
-- say whether the new image says anything different to a reader, which is the only part of a
-- release anybody outside this repository experiences.
--
-- One row per boot. `verify` fills it the first time it is asked after a restart and reads it
-- afterwards, so the cost is paid once by whoever is watching the deploy and never by the poller.
-- The hash is over paths and rendered text that already went to a channel; no new upstream value
-- is stored, and the row is 200 bytes.
CREATE TABLE IF NOT EXISTS release_renders (
  boot_id TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL CHECK(computed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  booted_at TEXT NOT NULL CHECK(booted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  hash TEXT NOT NULL,
  cards INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  took_ms INTEGER NOT NULL
) WITHOUT ROWID;

-- Read newest-first to find the boot before this one, which is the only read there is.
CREATE INDEX IF NOT EXISTS release_renders_recent ON release_renders(booted_at DESC);

ANALYZE;
