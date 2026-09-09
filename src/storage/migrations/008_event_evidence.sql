ALTER TABLE events
  ADD COLUMN evidence_type TEXT NOT NULL DEFAULT 'unknown'
  CHECK(evidence_type IN (
    'api_catalogue',
    'availability_catalogue',
    'official_news',
    'arena_roster',
    'leaderboard',
    'web_diff',
    'github_activity',
    'package_release',
    'open_weights',
    'status_page',
    'deprecation',
    'unknown'
  ));

UPDATE events
SET evidence_type = CASE stream
  WHEN 'api-models' THEN 'api_catalogue'
  WHEN 'openrouter' THEN 'availability_catalogue'
  WHEN 'news' THEN 'official_news'
  WHEN 'arena' THEN 'arena_roster'
  WHEN 'leaderboards' THEN 'leaderboard'
  WHEN 'web' THEN 'web_diff'
  WHEN 'github' THEN 'github_activity'
  WHEN 'packages' THEN 'package_release'
  WHEN 'weights' THEN 'open_weights'
  WHEN 'incidents' THEN 'status_page'
  WHEN 'deprecations' THEN 'deprecation'
  ELSE 'unknown'
END;
