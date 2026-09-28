-- What kind of evidence a source produces, and what an event of it is worth before anything
-- corroborates it, as its registry entry declares.
--
-- Both were derived, at every insert and at every read, by a ladder of `if`s over the source id:
-- `github:` and `:releases` meant confirmed, `npm:` and `pypi:` meant confirmed, `huggingface:`
-- meant supported, and anything the ladder did not recognise fell silently to `observed`. So the
-- strength of a new source depended on what it had been named, and a source named differently was
-- weaker than its twin with nobody saying so -- the same class of rule AGENTS.md forbids for failure
-- messages, pointed at identifiers instead. The registry declares both now, once per kind, and a
-- source that declares neither does not compile.
--
-- These two columns are the `authority` and `vendor` story again, for the same reader: Model Facts
-- projects from current records rather than events, so it needs a source's contract without an event
-- to read it from. 037 added `sources.authority` for exactly that and this joins it. Startup
-- rewrites both for every registered source, so the backfill below only covers the history before
-- the first start after this ships.
--
-- The backfill reads the newest event of each source, which is where the same derivation has been
-- stored all along: every event of one source carries one evidence type and one collected
-- confidence, because the ladder read only the id, the stream and the authority, none of which move.
-- Verified against production before shipping: all 201 registered sources declare what the ladder
-- derived, and all 12,873 stored events keep whatever they were written with. Nothing here rewrites
-- an event; the card that went out carried the strength that was true when it was sent.

ALTER TABLE sources ADD COLUMN evidence_type TEXT
  CHECK(evidence_type IS NULL OR evidence_type IN (
    'api_catalogue', 'availability_catalogue', 'official_news', 'arena_roster', 'leaderboard',
    'web_diff', 'github_activity', 'package_release', 'open_weights', 'status_page', 'deprecation',
    'unknown'
  ));
ALTER TABLE sources ADD COLUMN confidence TEXT
  CHECK(confidence IS NULL OR confidence IN ('observed', 'supported', 'confirmed'));

UPDATE sources SET
  evidence_type=(SELECT e.evidence_type FROM events e WHERE e.source=sources.id ORDER BY e.id DESC LIMIT 1),
  confidence=(SELECT e.confidence FROM events e WHERE e.source=sources.id ORDER BY e.id DESC LIMIT 1);
