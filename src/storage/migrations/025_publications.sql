-- Editorial outcomes are separate from evidence; these rows never create signal events.
CREATE TABLE publications (
  ref TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL UNIQUE,
  published_at TEXT,
  status TEXT NOT NULL,
  headline TEXT NOT NULL,
  text_ru TEXT,
  text_en TEXT,
  targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
  checked_at TEXT NOT NULL
);
CREATE INDEX publications_date ON publications(published_at);

CREATE TRIGGER IF NOT EXISTS publications_published_at_shape_insert
BEFORE INSERT ON publications
WHEN NEW.published_at IS NOT NULL AND NEW.published_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.published_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS publications_published_at_shape_update
BEFORE UPDATE OF published_at ON publications
WHEN NEW.published_at IS NOT NULL AND NEW.published_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.published_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS publications_checked_at_shape_insert
BEFORE INSERT ON publications
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.checked_at must be an ISO-8601 UTC instant'); END;

CREATE TRIGGER IF NOT EXISTS publications_checked_at_shape_update
BEFORE UPDATE OF checked_at ON publications
WHEN NEW.checked_at IS NOT NULL AND NEW.checked_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
BEGIN SELECT RAISE(ABORT, 'publications.checked_at must be an ISO-8601 UTC instant'); END;
