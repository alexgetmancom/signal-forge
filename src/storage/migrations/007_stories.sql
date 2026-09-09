CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  vendor TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped')),
  current_status TEXT NOT NULL DEFAULT 'active' CHECK(current_status IN ('active', 'removed'))
);

CREATE TABLE story_events (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(story_id, event_id)
);

CREATE INDEX stories_updated ON stories(updated_at);
CREATE INDEX story_events_event ON story_events(event_id);
