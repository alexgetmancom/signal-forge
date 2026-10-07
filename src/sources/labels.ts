import { WATCHED_SITES } from "./pages.js";
import { VENDOR_NAMES } from "./vendors.js";

const STATIC_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  stepfun: "StepFun API",
  "openai-docs-index": "OpenAI · docs index",
  "antigravity-cli-build": "Antigravity · CLI build",
  "discovery:claude-downloads": "Claude · downloads · discovery",
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
  "qwen-blog": "Qwen · blog",
  "minimax-release-notes": "MiniMax · release notes",
  "kimi-docs": "Kimi · API docs",
  "zai-release-notes": "Z.ai · release notes",
  "xiaomi-news": "Xiaomi MiMo · news",
  "deepseek-sitemap": "DeepSeek · API docs sitemap",
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
  "openai-deployment-safety": "OpenAI · system cards",
  "openai-learn-index": "OpenAI · learn index",
  "openai-showcase-index": "OpenAI · developer showcase",
  "kimi-code-changelog": "Kimi Code · changelog",
  "minimax-code-changelog": "MiniMax Code · changelog",
  "cohere-changelog": "Cohere · changelog",
  polymarket: "Polymarket · AI release markets",
  voxelbench: "VoxelBench · leaderboard",
  weirdml: "WeirdML · leaderboard",
  simplebench: "SimpleBench · leaderboard",
  "claude-web": "Claude · interface",
  "claude-model-catalog": "Claude · client model catalogue",
  "codex-docs": "Codex · docs",
  // Named for what it tracks, not by its domain: a card does not advertise somebody else's site.
  "codex-resets": "Codex · weekly resets",
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
  "anthropic-pricing": "Anthropic · API pricing",
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
  // Named here because the id is what a reader saw otherwise: the card for Muse Spark 1.4 was
  // titled "muse-spark-1-4-contributor on discovery:opencode-data".
  "discovery:opencode-data": "OpenCode · discovery",
  "nvidia-ai-feed": "NVIDIA · AI feed",
};

/** Pure source naming used by both the registry and transport-neutral renderers. */
/**
 * What the tail of a source id says the source reads.
 *
 * Twenty-one registered sources answered `sourceLabel` with their own id on 2026-10-08, and an id
 * is not a place: a weights card read "Weights published on kaggle:google." Written as rules rather
 * than as twenty-one more rows, because the ids are not arbitrary -- a maker plus the surface of it
 * this reads -- and the next source to follow the pattern is then named before it is registered.
 */
const SURFACE_SUFFIXES: readonly { ending: string; reads: string }[] = [
  { ending: "-model-index", reads: "model index" },
  { ending: "-cli-models", reads: "model ids" },
  { ending: "-code-models", reads: "model ids" },
  { ending: "-models", reads: "model ids" },
  { ending: "-desktop-apt", reads: "desktop app" },
  { ending: "-changelog", reads: "changelog" },
  { ending: "-pricing", reads: "pricing" },
];

/** The slug of a maker or a product, spelled the way its own makers spell it. */
function surface(slug: string): string {
  const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const vendor = VENDOR_NAMES.find((name) => bare(name) === bare(slug));
  if (vendor) return vendor;
  return slug
    .split("-")
    .map((word) => SURFACE_WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The words a title case would get wrong, which is every one a product spells its own way. */
const SURFACE_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  chatgpt: "ChatGPT",
  cli: "CLI",
  zai: "Z.ai",
};

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
  if (id.startsWith("kaggle:")) return `Kaggle · ${surface(id.slice("kaggle:".length))}`;
  if (id.startsWith("discovery:docs-")) return `${surface(id.slice("discovery:docs-".length))} · docs · discovery`;
  if (id.startsWith("discovery:blog-")) return `${surface(id.slice("discovery:blog-".length))} · blog · discovery`;
  const google = id.match(/^google-blog-([a-z]{2})$/);
  if (google) return `Google · blog · ${(google[1] ?? "").toUpperCase()}`;
  const suffix = SURFACE_SUFFIXES.find((one) => id.endsWith(one.ending));
  if (suffix) return `${surface(id.slice(0, -suffix.ending.length))} · ${suffix.reads}`;
  if (id.startsWith("npm:")) return `npm · ${id.slice("npm:".length)}`;
  if (id.startsWith("pypi:")) return `PyPI · ${id.slice("pypi:".length)}`;
  if (id.startsWith("github:")) {
    const [, repository, kind] = id.split(":");
    // Only `pulls` reads pull requests. `models` reads the code itself and `talk` reads issues,
    // their comments and discussions, and both were labelled "PR" by a default that fit neither:
    // the card for `minimax-m3.1` said a pull request had named it when a test file had.
    const suffix =
      kind === "commits" || kind === "releases" || kind === "pulls"
        ? (kind as string).replace("pulls", "PR")
        : kind === "talk"
          ? "discussions"
          : "code";
    return `GitHub · ${repository ?? id} · ${suffix}`;
  }
  return id;
}
