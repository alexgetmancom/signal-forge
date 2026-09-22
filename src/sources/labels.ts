import { WATCHED_SITES } from "./pages.js";

const STATIC_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  "models-dev": "models.dev · catalogue",
  "truefoundry-azure": "TrueFoundry · Azure catalogue",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  arena: "Arena",
  "arena-leaderboards": "Arena · leaderboards",
  "story-digest": "Signal Forge · story digest",
  "openai-news": "OpenAI · news",
  hackernews: "Hacker News · front page",
  "openai-chatgpt-release-notes": "OpenAI · ChatGPT release notes",
  "openai-codex-changelog": "OpenAI · Codex changelog",
  "openai-api-changelog": "OpenAI · API changelog",
  "anthropic-news": "Anthropic · news",
  "anthropic-routes": "Anthropic · site pages",
  "openai-sitemap": "OpenAI · sitemap",
  "deepmind-sitemap": "Google DeepMind · sitemap",
  "anthropic-sitemap": "Anthropic · sitemap",
  "xiaomi-sitemap": "Xiaomi MiMo · sitemap",
  "zai-sitemap": "Z.ai · docs sitemap",
  "meta-blog": "Meta AI · blog",
  "claude-blog": "Claude · blog",
  "mimo-training": "Xiaomi MiMo · training runs",
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
  "huggingface-router": "Hugging Face · inference providers",
  "google-ai-blog": "Google · AI blog",
  "gemini-models-blog": "Google · Gemini models blog",
  "gemini-app-blog": "Google · Gemini app blog",
  "deepmind-blog": "Google DeepMind · blog",
  "nvidia-developer-blog": "NVIDIA · developer blog",
  "codex-models": "Codex · model list",
  "opencode-zen": "OpenCode Zen · models",
  "opencode-go": "OpenCode Go · models",
  "command-code-models": "Command Code · models",
  "google-skus": "Google Cloud · price list",
  "claude-code-models": "Claude Code · model ids",
  "openai-alignment": "OpenAI · alignment blog",
  "kimi-code-changelog": "Kimi Code · changelog",
  "minimax-code-changelog": "MiniMax Code · changelog",
  "cohere-changelog": "Cohere · changelog",
  polymarket: "Polymarket · AI release markets",
  voxelbench: "VoxelBench · leaderboard",
  weirdml: "WeirdML · leaderboard",
  simplebench: "SimpleBench · leaderboard",
  "claude-web": "Claude · interface",
  "codex-docs": "Codex · docs",
  "codex-resets": "codex-resets.com",
  "vercel-gateway": "Vercel AI Gateway",
  "cursor-changelog": "Cursor · changelog",
  "app:ios:chatgpt": "App Store · ChatGPT",
  "app:ios:claude": "App Store · Claude",
  "app:ios:gemini": "App Store · Gemini",
  "app:ios:grok": "App Store · Grok",
  "app:ios:deepseek": "App Store · DeepSeek",
  "app:ios:perplexity": "App Store · Perplexity",
  "app:ios:kimi": "App Store · Kimi",
  "app:ios:mistral": "App Store · Mistral",
  "app:ios:notebooklm": "App Store · NotebookLM",
  "app:ios:meta-ai": "App Store · Meta AI",
  "app:ios:suno": "App Store · Suno",
  "status:openai": "OpenAI · status",
  "status:anthropic": "Anthropic · status",
  "status:deepseek": "DeepSeek · status",
  "status:moonshot": "Moonshot · status",
  "openai-deprecations": "OpenAI · deprecations",
  "anthropic-deprecations": "Anthropic · deprecations",
  "gemini-deprecations": "Gemini · deprecations",
  "vertex-deprecations": "Vertex AI · deprecations",
  "vertex-quotas": "Vertex AI · quotas",
  "vertex-model-garden": "Vertex AI · Model Garden",
  "aws-bedrock-lifecycle": "AWS Bedrock · lifecycle",
  bedrock: "AWS Bedrock · catalogue",
  "azure-foundry-lifecycle": "Azure Foundry · lifecycle",
  "groq-deprecations": "Groq · deprecations",
  "cohere-deprecations": "Cohere · deprecations",
  "xai-deprecations": "xAI · deprecations",
  "artificial-analysis": "Artificial Analysis · benchmarks",
  xai: "xAI API",
  zai: "Z.ai API",
  meta: "Meta · Llama API",
  moonshot: "Moonshot API",
  kimi: "Kimi API",
  "openrouter-usage": "OpenRouter · usage",
  mistral: "Mistral API",
  groq: "Groq API",
  minimax: "MiniMax API",
  dashscope: "Alibaba Model Studio API",
  cerebras: "Cerebras API",
  mimo: "Xiaomi MiMo API",
  poolside: "Poolside API",
  deepinfra: "DeepInfra API",
};

/** Pure source naming used by both the registry and transport-neutral renderers. */
export function sourceLabel(id: string): string {
  const staticLabel = STATIC_LABELS[id];
  if (staticLabel) return staticLabel;
  if (id.startsWith("huggingface:")) return `Hugging Face · ${id.slice("huggingface:".length)}`;
  if (id === "discovery:huggingface-trending") return "Hugging Face · trending";
  if (id.startsWith("discovery:github-")) return `GitHub · discovery · ${id.slice("discovery:github-".length)}`;
  if (id === "modelscope:recent") return "ModelScope · recent";
  if (id.startsWith("modelscope:")) return `ModelScope · ${id.slice("modelscope:".length)}`;
  if (id.startsWith("artificial-analysis:"))
    return `Artificial Analysis · ${id.slice("artificial-analysis:".length)} arena`;
  if (id.startsWith("designarena:")) return `DesignArena · ${id.slice("designarena:".length)}`;
  if (id.startsWith("app:ios:")) return `App Store · ${id.slice("app:ios:".length)}`;
  if (id.startsWith("pages:")) {
    const site = WATCHED_SITES.find((one) => one.id === id.slice("pages:".length));
    return site ? site.name : `${id.slice("pages:".length)} · site pages`;
  }
  if (id.startsWith("npm:")) return `npm · ${id.slice("npm:".length)}`;
  if (id.startsWith("pypi:")) return `PyPI · ${id.slice("pypi:".length)}`;
  if (id.startsWith("github:")) {
    const [, repository, kind] = id.split(":");
    const suffix = kind === "commits" ? "commits" : kind === "releases" ? "releases" : "PR";
    return `GitHub · ${repository ?? id} · ${suffix}`;
  }
  return id;
}
