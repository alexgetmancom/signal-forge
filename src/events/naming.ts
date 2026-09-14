import { displayName } from "./variants.js";
import { vendorSpelling } from "./vendors.js";

/**
 * The name of a model as a reader says it out loud.
 *
 * Catalogues store handles: `gpt-image-2.5-flare`, `deepseek-ai/DeepSeek-V4.1-Flash`,
 * `nvidia/Nemotron-3-Labs-Ultra-Math-RL`. A card and a weekly recap that print those are showing a
 * reader the key rather than the thing, and the difference between "GPT Image 2.5 Flare" and
 * `gpt-image-2.5-flare` is whether the week looks like news or like a database dump.
 *
 * A handle is rewritten only when it is a handle: a name that already has spaces in it was written
 * by whoever published it, and is left exactly as it was.
 */

/** Words a title case would ruin. */
const SHOUTED = new Set([
  "ai",
  "api",
  "gpt",
  "llm",
  "vl",
  "ocr",
  "tts",
  "stt",
  "asr",
  "rl",
  "sft",
  "dpo",
  "rlhf",
  "moe",
  "hd",
  "xl",
  "ui",
  "sdk",
  "cli",
  "3d",
  "2d",
  "nvfp4",
  "fp4",
  "fp8",
  "bf16",
]);

/**
 * A sighting is a literal string, not a name.
 *
 * `amber_fern` on the Arena and `openai/some-repo` on GitHub are the evidence themselves: a reader
 * searches for exactly those characters, and prettifying one into "Amber Fern" hands them something
 * that matches nothing. Only catalogue entries, where the handle stands in for a published product,
 * are rewritten.
 */
function isLiteralSighting(stream: string, source: string): boolean {
  return stream === "arena" || stream === "leaderboards" || source.startsWith("discovery:");
}

function word(part: string): string {
  if (!part) return part;
  if (/[A-Z]/.test(part)) return part;
  const maker = vendorSpelling(part);
  if (maker) return maker;
  if (SHOUTED.has(part.toLowerCase())) return part.toUpperCase();
  if (/^v\d/.test(part)) return `V${part.slice(1)}`;
  if (/^\d/.test(part)) return part;
  return part[0]?.toUpperCase() + part.slice(1);
}

export function readableName(raw: string): string {
  const trimmed = displayName(raw);
  if (!trimmed) return raw;
  // Already written for a reader: `Inception: Mercury 2.5`, `GPT-6 Astra`.
  if (/\s/.test(trimmed)) return trimmed;
  // A registry namespace says who published it, which the card says elsewhere.
  const handle = trimmed.includes("/") ? (trimmed.split("/").at(-1) ?? trimmed) : trimmed;
  const parts = handle.split(/[-_]/).filter(Boolean);
  if (parts.length < 2) return handle;
  // An acronym keeps the hyphen before a version number, because that is how makers write it:
  // GPT-6, never "GPT 6". Before an ordinary word the hyphen goes, or "AI-For-Media" survives it.
  const joined = (index: number) =>
    SHOUTED.has((parts[index - 1] ?? "").toLowerCase()) && /^\d/.test(parts[index] ?? "") ? "-" : " ";
  return parts.map(word).reduce((line, next, index) => line + joined(index) + next);
}

/** The title of a card: the published name where there is one, the literal sighting where there is not. */
export function displayTitle(name: string, stream: string, source: string): string {
  return isLiteralSighting(stream, source) ? name : readableName(name);
}
