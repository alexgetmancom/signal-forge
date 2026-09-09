/** Broad source families are used for independence counts; multiple URLs in one family count once. */
export function sourceFamily(source: string, stream = ""): string {
  if (source.startsWith("discovery:github-")) return "discovery:github";
  if (source.startsWith("github:")) return "github";
  if (source.startsWith("huggingface:")) return "huggingface";
  if (source === "discovery:huggingface-recent") return "huggingface";
  if (source.startsWith("modelscope:")) return "modelscope";
  if (source.startsWith("designarena:")) return "designarena";
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("pypi:")) return "pypi";
  if (source.startsWith("status:")) return "status";
  if (source === "arena" || source === "arena-leaderboards") return "arena";
  if (source === "openrouter") return "openrouter";
  if (stream === "api-models") return "provider-api";
  if (stream === "news") return "official-news";
  if (stream === "deprecations") return "deprecations";
  return source;
}
