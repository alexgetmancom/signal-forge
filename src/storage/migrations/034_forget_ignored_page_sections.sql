-- Pages in sections a site no longer reads are forgotten, not reported gone.
--
-- On 2026-09-16 `pages:openai` stopped reading `index`, `business` and `events`, and
-- `pages:claude-docs` stopped reading its eleven translations. The next collections kept 116 of 788
-- and 643 of 3,415 records, the shrink guard refused both as degraded, and neither site collected
-- again. The stored rows are exactly those sections (672 and 2,772, counted on production), so they
-- go here: deleted records emit no events, where letting a collection drop them would announce
-- thousands of pages as removed.

DELETE FROM records
WHERE source = 'pages:openai'
  AND (id GLOB '/index' OR id GLOB '/index/*' OR id GLOB '/business' OR id GLOB '/business/*'
    OR id GLOB '/events' OR id GLOB '/events/*');

DELETE FROM records
WHERE source = 'pages:claude-docs'
  AND (id GLOB '/docs/de/*' OR id GLOB '/docs/es/*' OR id GLOB '/docs/fr/*' OR id GLOB '/docs/id/*'
    OR id GLOB '/docs/it/*' OR id GLOB '/docs/ja/*' OR id GLOB '/docs/ko/*' OR id GLOB '/docs/pt-BR/*'
    OR id GLOB '/docs/ru/*' OR id GLOB '/docs/zh-CN/*' OR id GLOB '/docs/zh-TW/*'
    OR id IN ('/docs/de', '/docs/es', '/docs/fr', '/docs/id', '/docs/it', '/docs/ja', '/docs/ko',
              '/docs/pt-BR', '/docs/ru', '/docs/zh-CN', '/docs/zh-TW'));
