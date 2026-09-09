ALTER TABLE events ADD COLUMN confidence TEXT NOT NULL DEFAULT 'observed' CHECK(confidence IN ('observed', 'supported', 'confirmed', 'shipped'));
