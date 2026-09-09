import type { Confidence, Event } from "./types.js";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["observed", "supported", "confirmed", "shipped"];

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
  if (source.startsWith("huggingface:") || source.startsWith("modelscope:")) return "supported";
  if (source.startsWith("status:")) return "confirmed";
  if (stream === "api-models" && source !== "openrouter" && source !== "vercel-gateway") return "confirmed";
  if (stream === "deprecations") return "confirmed";
  if (stream === "news") return "supported";
  return "observed";
}

export function strongerConfidence(left: Confidence, right: Confidence): Confidence {
  return rank[left] >= rank[right] ? left : right;
}

export function eventConfidence(event: Pick<Event, "source" | "stream">): Confidence {
  return confidenceFor(event.source, event.stream);
}
