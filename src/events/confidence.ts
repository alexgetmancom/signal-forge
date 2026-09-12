import type { Confidence, Event, EvidenceType, SourceAuthority } from "./types.js";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["observed", "supported", "confirmed", "shipped"];

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  "api_catalogue",
  "availability_catalogue",
  "official_news",
  "arena_roster",
  "leaderboard",
  "web_diff",
  "github_activity",
  "package_release",
  "open_weights",
  "status_page",
  "deprecation",
  "unknown",
];

export const SOURCE_AUTHORITIES: readonly SourceAuthority[] = ["first_party", "vendor_owned", "third_party"];

const evidenceLabels: Record<EvidenceType, string> = {
  api_catalogue: "API catalogue",
  availability_catalogue: "availability catalogue",
  official_news: "official news",
  arena_roster: "Arena roster",
  leaderboard: "leaderboard",
  web_diff: "web diff",
  github_activity: "GitHub activity",
  package_release: "package release",
  open_weights: "open weights registry",
  status_page: "status page",
  deprecation: "deprecation notice",
  unknown: "unknown evidence",
};

const rank: Record<Confidence, number> = {
  observed: 0,
  supported: 1,
  confirmed: 2,
  shipped: 3,
};

/** Source semantics, not an LLM judgment, assign the initial confidence label. */
export function confidenceFor(source: string, stream: string): Confidence {
  if (source.startsWith("github:") && source.endsWith(":releases")) return "shipped";
  if (source.startsWith("npm:") || source.startsWith("pypi:")) return "shipped";
  if (source === "cursor-changelog") return "shipped";
  if (stream === "apps") return "shipped";
  if (source.startsWith("huggingface:") || source.startsWith("modelscope:")) return "supported";
  if (source.startsWith("status:")) return "confirmed";
  if (stream === "api-models" && source !== "openrouter" && source !== "vercel-gateway") return "confirmed";
  if (stream === "deprecations") return "confirmed";
  if (stream === "news") return "supported";
  return "observed";
}

/** Names the kind of primary evidence behind an event; this is a source contract, not a guess. */
export function evidenceTypeFor(source: string, stream: string): EvidenceType {
  if (source === "openrouter" || stream === "openrouter") return "availability_catalogue";
  if (stream === "api-models") return "api_catalogue";
  if (stream === "news") return "official_news";
  if (stream === "arena") return "arena_roster";
  if (stream === "leaderboards") return "leaderboard";
  if (stream === "web" || stream === "pages") return "web_diff";
  if (stream === "github") return "github_activity";
  if (stream === "packages") return "package_release";
  // An app store listing is a release register like any other: a version, a date, vendor notes.
  if (stream === "apps") return "package_release";
  if (stream === "weights") return "open_weights";
  if (stream === "incidents") return "status_page";
  if (stream === "deprecations") return "deprecation";
  return "unknown";
}

/** Ownership of the source surface, kept separate from its health and evidence confidence. */
export function authorityForSource(source: string): SourceAuthority {
  if (
    [
      "openai",
      "anthropic",
      "gemini",
      "openai-news",
      "openai-chatgpt-release-notes",
      "openai-codex-changelog",
      "openai-api-changelog",
      "anthropic-news",
      "gemini-api-changelog",
      "xai-release-notes",
      "mistral-release-notes",
      "groq-changelog",
      "deepseek-updates",
      "deepseek-pricing",
      "claude-code-changelog",
      "anthropic-sdk-releases",
      "codex-docs",
      "claude-web",
      "cursor-changelog",
      "openai-deprecations",
      "anthropic-deprecations",
      "gemini-deprecations",
      "vertex-deprecations",
      "aws-bedrock-lifecycle",
      "azure-foundry-lifecycle",
      "groq-deprecations",
      "cohere-deprecations",
      "xai-deprecations",
    ].includes(source) ||
    source.startsWith("status:") ||
    source.startsWith("deepseek:")
  )
    return "first_party";
  if (
    source.startsWith("huggingface:") ||
    source === "huggingface-blog-feed" ||
    source.startsWith("modelscope:") ||
    source.startsWith("npm:") ||
    source.startsWith("pypi:")
  )
    return "vendor_owned";
  return "third_party";
}

export function evidenceLabel(type: EvidenceType): string {
  return evidenceLabels[type];
}

export function strongerConfidence(left: Confidence, right: Confidence): Confidence {
  return rank[left] >= rank[right] ? left : right;
}

export function eventConfidence(event: Pick<Event, "source" | "stream">): Confidence {
  return confidenceFor(event.source, event.stream);
}

/**
 * How solid this is, in the words someone who does not work here would use.
 *
 * `observed`, `supported`, `confirmed` and `shipped` are accurate and mean nothing to a reader:
 * the difference between a rumour and a fact was carried in a footer that read
 * "Evidence: arena roster · Confidence: observed". The sentence is keyed on the evidence type
 * because that is a source contract rather than a judgement, and it never claims more than the
 * source proves — a reseller's catalogue is not the vendor saying so.
 */
const standings: Record<EvidenceType, string> = {
  api_catalogue: "Listed in the provider's own API.",
  availability_catalogue: "Seen in a reseller's catalogue, not announced by the maker.",
  official_news: "The maker announced this themselves.",
  arena_roster: "Spotted on a public arena. Nobody has said what it is yet.",
  leaderboard: "Reported by a public leaderboard.",
  web_diff: "Spotted as a change on the maker's own site, with no announcement.",
  github_activity: "From the project's repository. Work in progress, not a release.",
  package_release: "Published to the registry. You can install it now.",
  open_weights: "Published to an open-weights registry. The files are downloadable.",
  status_page: "From the provider's own status page.",
  deprecation: "From the provider's own retirement notice.",
  unknown: "",
};

const fallback: Record<Confidence, string> = {
  observed: "Seen by one source, unconfirmed.",
  supported: "Backed by the maker's own words.",
  confirmed: "Confirmed by the provider directly.",
  shipped: "Out now.",
};

/**
 * One sentence about how much weight the observation carries, or null when it adds nothing.
 *
 * Discord cards only. The Telegram renderer's line offsets are read back by `needsSummary`, so an
 * extra line there would quietly move the summarisation threshold for every event, and no Telegram
 * destination is configured to benefit from it.
 */
export function readerStanding(event: Event): string | null {
  const type = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  const sentence = standings[type] || fallback[event.confidence ?? "observed"];
  return sentence || null;
}
