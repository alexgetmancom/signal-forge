/** Source families collapse known duplicate surfaces while keeping unrelated source IDs independent. */
export function sourceFamily(source: string, stream = ""): string {
  if (source.startsWith("discovery:github-")) return "discovery:github";
  if (source.startsWith("github:")) {
    const separator = source.lastIndexOf(":");
    return separator > "github:".length ? source.slice(0, separator) : source;
  }
  if (source.startsWith("huggingface:")) return "huggingface";
  if (source === "discovery:huggingface-recent") return "huggingface";
  if (source.startsWith("modelscope:")) return "modelscope";
  if (source.startsWith("designarena:")) return "designarena";
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("pypi:")) return "pypi";
  if (source === "arena" || source === "arena-leaderboards") return "arena";
  if (source === "openrouter") return "openrouter";
  if (stream === "api-models") return `provider-api:${source}`;
  if (stream === "news") return `official-news:${source}`;
  if (stream === "deprecations") return `deprecations:${source}`;
  return source;
}

const FIRST_PARTY_VENDOR_BY_SOURCE: Record<string, string> = {
  openai: "OpenAI",
  "openai-news": "OpenAI",
  "openai-chatgpt-release-notes": "OpenAI",
  "openai-codex-changelog": "OpenAI",
  "openai-api-changelog": "OpenAI",
  "openai-deprecations": "OpenAI",
  "status:openai": "OpenAI",
  "codex-docs": "OpenAI",
  anthropic: "Anthropic",
  "anthropic-news": "Anthropic",
  "anthropic-deprecations": "Anthropic",
  "status:anthropic": "Anthropic",
  "claude-code-changelog": "Anthropic",
  "anthropic-sdk-releases": "Anthropic",
  "claude-web": "Anthropic",
  gemini: "Google",
  "gemini-api-changelog": "Google",
  "gemini-deprecations": "Google",
  "vertex-deprecations": "Google",
  "deepseek-pricing": "DeepSeek",
  "deepseek-updates": "DeepSeek",
  "deepseek-news": "DeepSeek",
  "xai-release-notes": "xAI",
  "xai-deprecations": "xAI",
  "mistral-release-notes": "Mistral",
  "groq-changelog": "Groq",
  "groq-deprecations": "Groq",
  "cohere-deprecations": "Cohere",
  "aws-bedrock-lifecycle": "AWS",
  "azure-foundry-lifecycle": "Microsoft",
};

/** Independent confirmation must not count two official surfaces from the same vendor twice. */
export function sourceIndependenceFamily(source: string, stream = ""): string {
  const vendor = FIRST_PARTY_VENDOR_BY_SOURCE[source];
  return vendor && ["api-models", "news", "deprecations", "incidents", "web"].includes(stream)
    ? `first-party:${vendor}`
    : sourceFamily(source, stream);
}
