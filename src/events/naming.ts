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
  "glm",
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

/**
 * Words a maker capitalises inside, which no rule derives. Z.ai's `glm-5.3-flashx` reached the
 * public channel on 2026-09-18 as "Glm 5.3 Flashx" while the Vercel card for the same model said
 * "GLM 5.3 FlashX".
 */
const SPELLED: Readonly<Record<string, string>> = { flashx: "FlashX" };

function word(part: string): string {
  if (!part) return part;
  if (/[A-Z]/.test(part)) return part;
  const spelled = SPELLED[part.toLowerCase()];
  if (spelled) return spelled;
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
  const product = releasedProduct(name, source);
  if (product) return product;
  return isLiteralSighting(stream, source) ? name : readableName(name);
}

/**
 * A release named only by its version says nothing on its own: openai/codex titles releases
 * "0.155.0", which reached #signals as a bare number on 2026-09-18. The repository names the product.
 */
function releasedProduct(name: string, source: string): string | null {
  const repo = /^github:[^/]+\/([^:]+):releases$/.exec(source)?.[1];
  if (!repo || !/^v?\d+(\.\d+)+\S*$/.test(name.trim())) return null;
  const product = readableName(repo);
  return `${product.charAt(0).toUpperCase()}${product.slice(1)} ${name.trim().replace(/^v/, "")}`;
}
