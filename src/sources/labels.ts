const STATIC_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  arena: "Arena",
  "arena-leaderboards": "Arena · leaderboards",
  "story-digest": "Signal Forge · story digest",
  "openai-news": "OpenAI · news",
  "openai-chatgpt-release-notes": "OpenAI · ChatGPT release notes",
  "openai-codex-changelog": "OpenAI · Codex changelog",
  "openai-api-changelog": "OpenAI · API changelog",
  "anthropic-news": "Anthropic · news",
  "gemini-api-changelog": "Gemini · API changelog",
  "xai-release-notes": "xAI · release notes",
  "mistral-release-notes": "Mistral · release notes",
  "groq-changelog": "Groq · changelog",
  "deepseek-updates": "DeepSeek · updates",
  "deepseek-pricing": "DeepSeek · API pricing",
  "deepseek-api": "DeepSeek API",
  "claude-code-changelog": "Claude Code · changelog",
  "anthropic-sdk-releases": "Anthropic · SDK releases",
  "huggingface-blog-feed": "Hugging Face · blog",
  "claude-web": "Claude · interface",
  "codex-docs": "Codex · docs",
  "vercel-gateway": "Vercel AI Gateway",
  "cursor-changelog": "Cursor · changelog",
  "app:ios:chatgpt": "App Store · ChatGPT",
  "app:ios:claude": "App Store · Claude",
  "app:ios:gemini": "App Store · Gemini",
  "app:ios:grok": "App Store · Grok",
  "app:ios:deepseek": "App Store · DeepSeek",
  "status:openai": "OpenAI · status",
  "status:anthropic": "Anthropic · status",
  "openai-deprecations": "OpenAI · deprecations",
  "anthropic-deprecations": "Anthropic · deprecations",
  "gemini-deprecations": "Gemini · deprecations",
  "vertex-deprecations": "Vertex AI · deprecations",
  "aws-bedrock-lifecycle": "AWS Bedrock · lifecycle",
  "azure-foundry-lifecycle": "Azure Foundry · lifecycle",
  "groq-deprecations": "Groq · deprecations",
  "cohere-deprecations": "Cohere · deprecations",
  "xai-deprecations": "xAI · deprecations",
  "artificial-analysis": "Artificial Analysis · benchmarks",
  xai: "xAI API",
  zai: "Z.ai API",
  moonshot: "Moonshot API",
  mistral: "Mistral API",
  groq: "Groq API",
};

/** Pure source naming used by both the registry and transport-neutral renderers. */
export function sourceLabel(id: string): string {
  const staticLabel = STATIC_LABELS[id];
  if (staticLabel) return staticLabel;
  if (id.startsWith("huggingface:")) return `Hugging Face · ${id.slice("huggingface:".length)}`;
  if (id === "discovery:huggingface-recent") return "Hugging Face · recent discovery";
  if (id.startsWith("discovery:github-")) return `GitHub · discovery · ${id.slice("discovery:github-".length)}`;
  if (id === "modelscope:recent") return "ModelScope · recent";
  if (id.startsWith("modelscope:")) return `ModelScope · ${id.slice("modelscope:".length)}`;
  if (id.startsWith("designarena:")) return `DesignArena · ${id.slice("designarena:".length)}`;
  if (id.startsWith("app:ios:")) return `App Store · ${id.slice("app:ios:".length)}`;
  if (id.startsWith("pages:")) return `${id.slice("pages:".length)} · site pages`;
  if (id.startsWith("npm:")) return `npm · ${id.slice("npm:".length)}`;
  if (id.startsWith("pypi:")) return `PyPI · ${id.slice("pypi:".length)}`;
  if (id.startsWith("github:")) {
    const [, repository, kind] = id.split(":");
    const suffix = kind === "commits" ? "commits" : kind === "releases" ? "releases" : "PR";
    return `GitHub · ${repository ?? id} · ${suffix}`;
  }
  return id;
}
