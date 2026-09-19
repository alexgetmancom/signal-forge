-- What a model said about an event, kept beside the evidence and never in it.
--
-- Jev's judgements lived in app_state under 'jev:<event id>', one opaque JSON value per key. That
-- held the answer but not which model gave it or under which questions, so a change of prompt or
-- model would have silently mixed two judges in one column, and the comparison the judgements are
-- kept for -- rules against Jev, one prompt against the next -- could not be run. A row per
-- (event, evaluator, prompt version) keeps each judge's answers apart; events.id cascades, so a
-- judgement no longer outlives the event it was about, as the app_state keys did.
--
-- Judgements already stored are carried over as prompt version 1 of jev-latest, which is what
-- produced every one of them; keys whose event retention had already removed are dropped.

CREATE TABLE event_evaluations (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  evaluator TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  worth INTEGER NOT NULL,
  codename REAL NOT NULL,
  confidence REAL,
  rules TEXT NOT NULL,
  evaluated_at TEXT NOT NULL CHECK(evaluated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (event_id, evaluator, prompt_version)
);

CREATE INDEX event_evaluations_evaluated ON event_evaluations(evaluated_at);

INSERT INTO event_evaluations(event_id, evaluator, model, prompt_version, kind, worth, codename, confidence, rules, evaluated_at)
SELECT CAST(substr(s.key, 5) AS INTEGER), 'jev', 'jev-latest', '1',
       json_extract(s.value, '$.kind'), json_extract(s.value, '$.worth'), json_extract(s.value, '$.codename'),
       json_extract(s.value, '$.confidence'), json_extract(s.value, '$.rules'), json_extract(s.value, '$.at')
  FROM app_state s
 WHERE s.key GLOB 'jev:[0-9]*'
   AND json_valid(s.value)
   AND EXISTS (SELECT 1 FROM events e WHERE e.id = CAST(substr(s.key, 5) AS INTEGER));

DELETE FROM app_state WHERE key GLOB 'jev:[0-9]*';
