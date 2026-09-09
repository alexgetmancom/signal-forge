ALTER TABLE events ADD COLUMN authority TEXT NOT NULL DEFAULT 'third_party'
CHECK(authority IN ('first_party', 'vendor_owned', 'third_party'));

UPDATE events
SET authority = CASE
  WHEN source IN (
    'openai', 'anthropic', 'gemini', 'openai-news', 'openai-chatgpt-release-notes', 'anthropic-news',
    'gemini-api-changelog', 'xai-release-notes', 'mistral-release-notes', 'groq-changelog', 'deepseek-updates', 'deepseek-news',
    'deepseek-pricing', 'codex-docs', 'claude-web', 'cursor-changelog', 'openai-deprecations',
    'anthropic-deprecations', 'gemini-deprecations', 'vertex-deprecations', 'aws-bedrock-lifecycle',
    'azure-foundry-lifecycle', 'groq-deprecations', 'cohere-deprecations', 'xai-deprecations',
    'openai-developer-feed', 'codex-skills', 'claude-code-changelog', 'anthropic-sdk-releases',
    'google-ai-feed', 'google-deepmind-feed', 'microsoft-ai-feed', 'nvidia-ai-feed'
  ) OR source LIKE 'status:%' OR source LIKE 'deepseek:%' THEN 'first_party'
  WHEN source LIKE 'huggingface:%' OR source LIKE 'modelscope:%' OR source LIKE 'npm:%' OR source LIKE 'pypi:%' THEN 'vendor_owned'
  ELSE 'third_party'
END;
