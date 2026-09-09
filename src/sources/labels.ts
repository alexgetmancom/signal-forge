const STATIC_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  arena: "Arena",
  "arena-leaderboards": "Arena · leaderboards",
  "openai-news": "OpenAI · news",
  "anthropic-news": "Anthropic · news",
  "claude-web": "Claude · interface",
  "codex-docs": "Codex · docs",
  "vercel-gateway": "Vercel AI Gateway",
  "cursor-changelog": "Cursor · changelog",
  "status:openai": "OpenAI · status",
  "status:anthropic": "Anthropic · status",
  "openai-deprecations": "OpenAI · deprecations",
  "anthropic-deprecations": "Anthropic · deprecations",
};

/** Pure source naming used by both the registry and transport-neutral renderers. */
export function sourceLabel(id: string): string {
  const staticLabel = STATIC_LABELS[id];
  if (staticLabel) return staticLabel;
  if (id.startsWith("huggingface:")) return `Hugging Face · ${id.slice("huggingface:".length)}`;
  if (id.startsWith("modelscope:")) return `ModelScope · ${id.slice("modelscope:".length)}`;
  if (id.startsWith("designarena:")) return `DesignArena · ${id.slice("designarena:".length)}`;
  if (id.startsWith("npm:")) return `npm · ${id.slice("npm:".length)}`;
  if (id.startsWith("pypi:")) return `PyPI · ${id.slice("pypi:".length)}`;
  if (id.startsWith("github:")) {
    const [, repository, kind] = id.split(":");
    const suffix = kind === "commits" ? "commits" : kind === "releases" ? "releases" : "PR";
    return `GitHub · ${repository ?? id} · ${suffix}`;
  }
  return id;
}
