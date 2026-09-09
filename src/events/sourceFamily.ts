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
