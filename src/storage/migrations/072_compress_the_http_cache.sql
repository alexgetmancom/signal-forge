-- Cached text becomes gzipped bytes. Drop the disposable cache; subsequent reads refill it in
-- the only supported format, at the cost of downloading each entry once.
DROP TABLE http_cache;
CREATE TABLE http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fresh_until_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' CHECK(fresh_until_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  body BLOB NOT NULL,
  used_at TEXT NOT NULL CHECK(used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);
