import { canonical } from "./canonical.js";
import type { Event, RecordData } from "./types.js";

const VENDORS: [RegExp, string][] = [
  [/openai|gpt|codex|chatgpt|sora/i, "OpenAI"],
  [/anthropic|claude/i, "Anthropic"],
  [/google|gemini|deepmind|lyria|imagen|veo/i, "Google"],
  [/x-ai|xai|grok/i, "xAI"],
  [/deepseek/i, "DeepSeek"],
  [/qwen|alibaba/i, "Qwen"],
  [/meta-llama|llama|^meta\//i, "Meta"],
  [/mistral/i, "Mistral"],
  [/groq/i, "Groq"],
  [/moonshot|kimi/i, "Moonshot"],
  [/minimax/i, "MiniMax"],
  [/z-ai|zhipu|glm/i, "Z.ai"],
  [/cohere/i, "Cohere"],
  [/perplexity/i, "Perplexity"],
];

/** The vendor an event is about, for role pings and presentation labels. */
export function vendorOf(event: Event, record: RecordData | null): string {
  const haystack = [record?.maker, record?.provider, event.entity_id, event.source]
    .filter((value) => typeof value === "string")
    .join(" ");
  return VENDORS.find(([pattern]) => pattern.test(haystack))?.[1] ?? "Unknown";
}

export function isRoutine(event: Event): boolean {
  if (event.source === "claude-web") return true;
  // A board is a standing, not an announcement. Climbing it, entering it and leaving it are all
  // worth reading together once an hour; none of them is worth interrupting somebody for.
  if (event.stream === "leaderboards") return true;
  if (event.kind !== "changed") return false;
  // A nightly or preview channel moves several times a day and says nothing about a product. The
  // release channels people actually install on stay immediate.
  if (event.stream === "packages" && !["latest", "stable"].includes(event.entity_id)) return true;
  if (!["openrouter", "api-models", "arena"].includes(event.stream)) return false;
  const before = JSON.parse(event.before_json ?? "{}") as Record<string, unknown>;
  const after = JSON.parse(event.after_json ?? "{}") as Record<string, unknown>;
  const important = [
    "name",
    "pricing",
    "context",
    "input",
    "output",
    "parameters",
    "capabilities",
    "selectable",
    "inputTokenLimit",
    "outputTokenLimit",
    "methods",
  ];
  const moved = important.filter((key) => canonical(before[key]) !== canonical(after[key]));
  // Three quarters of everything collected so far was a price moving by fractions of a cent.
  // Nobody reads a price at the moment it changes; they read it when working out a budget, and an
  // hourly "twelve models got cheaper" is that same information without twelve notifications.
  const budgetOnly = ["pricing", "context", "inputTokenLimit", "outputTokenLimit"];
  return moved.length === 0 || moved.every((key) => budgetOnly.includes(key));
}

/** Only appearance and disappearance carry an immediate vendor role mention. */
export function pingWorthy(event: Event): boolean {
  const pingable = new Set(["api-models", "openrouter", "weights", "arena", "deprecations", "news"]);
  return pingable.has(event.stream) && (event.kind === "new" || event.kind === "removed");
}
