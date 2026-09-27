-- What a story establishes, kept apart from what any one of its events said.
--
-- `events.confidence` is written once by the collector and never moves, and that is deliberate: an
-- event is immutable, the card that went out carried the strength that was true when it was sent,
-- and rewriting the row would make the archive disagree with the message. The cost is that a
-- three-level scale has been working as a flag. A model listed by OpenRouter at `observed`, then by
-- models.dev, then by the Vercel gateway, is three `observed` rows and a story whose `confidence`
-- column says `observed` -- because that column is the newest event's confidence, not the story's.
-- `signal_quality` already knows the shape of the miss and calls it `laterConfirmed`.
--
-- So the thing that rises is the derived claim. Three claims, because they are three different
-- questions and were being answered as one: `existence` (something by this name is real),
-- `availability` (a reader can call it today) and `identity` (we know which model these names are).
-- Each keeps its own confidence, when it reached it, and the events that carry it.
--
-- This is the one axis in the plan that is stored, and it is stored for the reason `stories` and
-- `model_facts` are: it is a projection, rebuilt from the events by `rebuildStories` and checked
-- for idempotence by `rehearse-projections`, not a fact recorded at collection time. The rule that
-- keeps a derived axis out of `events` -- `lifecycleState`, `claimType` -- is about the immutable
-- log, where a column would mean a migration and NULL over all history. Nothing here is written
-- that a rebuild cannot produce again.
--
-- `supported_by` is a bounded list of event ids, earliest first. It is capped because a story with
-- 400 catalogue rows would otherwise make this table grow with the noise rather than with the
-- claim, and the full list is `story_events`, which is what it was always read from. Ids only: no
-- upstream value is stored here, as nowhere else.
--
-- There is no count of supporting events, and its absence is the row's write rate: a count moves on
-- every event, so keeping one would mean writing three rows per event projected, which is the N+1
-- shape `correlationWorkload` exists to catch. A row is written when a claim appears, when it
-- rises, and while it is collecting its first few ids -- a handful of writes per story, not one per
-- event -- and how many events a story has is `story_events`, one join away.

CREATE TABLE story_claims (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  claim TEXT NOT NULL CHECK(claim IN ('existence', 'availability', 'identity')),
  confidence TEXT NOT NULL CHECK(confidence IN ('observed', 'supported', 'confirmed')),
  /** When any event first carried this claim at any strength. */
  first_at TEXT NOT NULL CHECK(first_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  /** When it reached the confidence it now holds, which is the date a rise actually happened. */
  raised_at TEXT NOT NULL CHECK(raised_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  supported_by TEXT NOT NULL,
  PRIMARY KEY(story_id, claim)
) WITHOUT ROWID;

-- The read this exists for is every claim of one story, which `listStories` asks once per row it
-- returns; the primary key is that index. It is named in src/storage/hotQueries.ts so that a plan
-- that stops using it fails a rehearsal rather than quietly scanning.
ANALYZE;
