import { canonical } from "./canonical.js";
import { incidentIsUrgent } from "./incidents.js";
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
  const haystack = [record?.maker, record?.provider, record?.owner, event.entity_id, event.source]
    .filter((value) => typeof value === "string")
    .join(" ");
  return VENDORS.find(([pattern]) => pattern.test(haystack))?.[1] ?? "Unknown";
}

export function isRoutine(event: Event): boolean {
  if (event.source === "claude-web") return true;
  // An outage is the one thing here that cannot wait for the top of the hour, but only when the
  // vendor itself calls it severe; everything else an incident does travels with the digest.
  if (event.stream === "incidents") return !incidentIsUrgent(event);
  if (event.stream === "leaderboards") {
    const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
    const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const beforeRank = typeof before?.rank === "number" ? before.rank : null;
    const afterRank = typeof after?.rank === "number" ? after.rank : null;
    const rankChanged = beforeRank !== afterRank;
    // A first-place movement is the one leaderboard event worth seeing immediately. Other board
    // churn stays in the hourly digest, and an unchanged first-place score does not interrupt. A
    // first-place departure is the corresponding immediate follow-up.
    const firstPlaceMovement = event.kind === "changed" && rankChanged && (beforeRank === 1 || afterRank === 1);
    const firstPlaceDeparture = event.kind === "removed" && beforeRank === 1;
    return !(firstPlaceMovement || firstPlaceDeparture);
  }
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
