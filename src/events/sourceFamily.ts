import type { SourceAuthority } from "./types.js";

/** Source families collapse known duplicate surfaces while keeping unrelated source IDs independent. */
export function sourceFamily(source: string, stream = ""): string {
  if (source.startsWith("discovery:github-")) return "discovery:github";
  if (source.startsWith("github:")) {
    const separator = source.lastIndexOf(":");
    return separator > "github:".length ? source.slice(0, separator) : source;
  }
  if (source.startsWith("huggingface:")) return "huggingface";
  if (source === "discovery:huggingface-trending") return "huggingface";
  if (source.startsWith("modelscope:")) return "modelscope";
  if (source.startsWith("designarena:")) return "designarena";
  if (source.startsWith("artificial-analysis")) return "artificial-analysis";
  if (source.startsWith("app:ios:")) return "app-store";
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("pypi:")) return "pypi";
  if (source === "arena" || source === "arena-leaderboards") return "arena";
  if (source === "openrouter") return "openrouter";
  if (stream === "api-models") return `provider-api:${source}`;
  if (stream === "news") return `official-news:${source}`;
  if (stream === "deprecations") return `deprecations:${source}`;
  return source;
}

/** What independence is judged from: the event's source, and who that source answers for. */
export type IndependenceEvidence = {
  source: string;
  stream: string;
  authority: SourceAuthority;
  vendor: string | null;
};

/**
 * Independent confirmation must not count two surfaces of one vendor twice: its API, its newsroom
 * and its app all say the same thing in one voice. The vendor is the one the registry declares for
 * the source, never the vendor of the model it reported; a host listing another maker's model is
 * still the host speaking.
 */
export function sourceIndependenceFamily(evidence: IndependenceEvidence): string {
  return evidence.authority !== "third_party" && evidence.vendor
    ? `vendor:${evidence.vendor}`
    : sourceFamily(evidence.source, evidence.stream);
}
