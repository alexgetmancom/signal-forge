import { text } from "../text.js";
import type { Event, RecordData } from "./types.js";

type IdentityStatus = "canonical" | "alias" | "codename" | "unconfirmed" | "unknown";

export type ModelIdentity = {
  canonicalId: string | null;
  displayName: string;
  aliases: string[];
  status: IdentityStatus;
};

export function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function displayName(event: Event, record: RecordData | null): string {
  return text(record?.name) ?? text(record?.model) ?? event.entity_id;
}

function stableId(record: RecordData | null, event: Event): string | null {
  const explicit = text(record?.canonical_id) ?? text(record?.canonicalId);
  if (explicit) return explicit;
  const id = text(record?.id) ?? event.entity_id;
  return event.stream === "packages" ? `${event.source}:${id}` : id;
}

/**
 * Derives identity only from evidence already present in the record. A leaderboard key is never
 * promoted to a canonical model ID: it remains a codename until another source identifies it.
 */
export function identityFor(event: Event, record: RecordData | null): ModelIdentity {
  const name = displayName(event, record);
  const id = stableId(record, event);
  const model = text(record?.model);
  const modelKey = text(record?.modelKey);

  if (event.stream === "leaderboards") {
    return {
      canonicalId: null,
      displayName: name,
      aliases: unique([modelKey, name]),
      status: modelKey && normalizeIdentity(modelKey) !== normalizeIdentity(name) ? "codename" : "unconfirmed",
    };
  }

  if (event.source.startsWith("discovery:github-")) {
    const repositoryId = id ?? event.entity_id;
    const repository = repositoryId.split("/").at(-1) ?? repositoryId;
    return {
      canonicalId: null,
      displayName: name,
      aliases: unique([repository, name, repositoryId]),
      status: "unconfirmed",
    };
  }

  if (event.stream === "arena") {
    return {
      canonicalId: null,
      displayName: name,
      aliases: unique([model, name, id]),
      status: model && normalizeIdentity(model) !== normalizeIdentity(name) ? "alias" : "unconfirmed",
    };
  }

  /**
   * A docs page is titled for its site -- "xAI Docs: Grok 4 7" -- and that prefix kept it out of the
   * Grok 4.7 story on 2026-09-21: the term was "xai docs grok 4 7" where the catalogue's was
   * "grok 4 7", so the check that silences a sighting after its launch never saw the two together
   * and the page reached the scouts. The page is named without its site, and a path ending in a
   * versioned name -- `/developers/grok-4-7` -- names the model too.
   */
  if (event.stream === "pages") {
    const title = name.replace(/^[^:]{1,40}:\s+/, "");
    const slug = (id ?? event.entity_id).split(/[?#]/)[0]?.replace(/\/+$/, "").split("/").at(-1) ?? "";
    const versioned = /^[a-z]+(?:-[a-z]+){0,2}-v?\d+(?:-\d+){0,2}(?:-[a-z]+)?$/i.test(slug) ? slug : null;
    return { canonicalId: null, displayName: title, aliases: unique([title, versioned]), status: "unknown" };
  }

  if (event.stream === "deprecations") {
    const canonicalId = text(record?.canonical_id) ?? text(record?.canonicalId) ?? text(record?.modelId);
    return {
      canonicalId,
      displayName: name,
      aliases: unique([name, canonicalId, id]).filter((value) => value !== canonicalId),
      status: canonicalId ? "canonical" : "unknown",
    };
  }

  if (["api-models", "openrouter", "weights", "packages"].includes(event.stream)) {
    return {
      canonicalId: id,
      displayName: name,
      aliases: unique([name, id]).filter((value) => value !== id),
      status: id ? "canonical" : "unknown",
    };
  }

  return { canonicalId: null, displayName: name, aliases: unique([name]), status: "unknown" };
}

/**
 * Words that say how a model is packaged or reached, not which model it is.
 *
 * One release arrives four times: `kimi-k3-official` and `kimi-k3-gateway` half an hour apart on
 * the Arena, `Mistral Small 4 (batch)` beside the model it batches, `gpt-image-2.5-flare` beside
 * `gpt-image-2.5-flare-2026-09-08`, and `nvidia/GLM-5.3-Flash-NVFP4` a day after Zhipu published
 * the weights it quantises. Each was a card of its own.
 *
 * Only markers that cannot distinguish two models belong here. A tier or a stage can: `max`,
 * `preview`, `mini` and `thinking` are left alone, because Pro and Pro Max are two products and a
 * preview is not the release.
 */
const VARIANT_MARKERS = new Set([
  "official",
  "gateway",
  "free",
  "batch",
  "hf",
  "nvfp4",
  "fp4",
  "fp8",
  "bf16",
  "int4",
  "int8",
  "awq",
  "gguf",
  "gptq",
  "mlx",
  "w8a8",
  "w4a16",
]);

function isDateTail(words: string[]): boolean {
  const [year, month, day] = words;
  return (
    /^20\d{2}$/.test(year ?? "") && /^\d{2}$/.test(month ?? "") && /^\d{2}$/.test(day ?? "") && Number(month) <= 12
  );
}

/**
 * One identity term with packaging removed, so that the same model written two ways meets itself.
 * Returns the term unchanged when nothing is stripped, and never strips it down to nothing.
 */
function baseIdentity(value: string): string {
  const words = normalizeIdentity(value).split(" ").filter(Boolean);
  while (words.length > 1) {
    const last = words.at(-1) ?? "";
    if (VARIANT_MARKERS.has(last) || /^\d{8}$/.test(last)) {
      words.pop();
      continue;
    }
    if (words.length > 3 && isDateTail(words.slice(-3))) {
      words.splice(-3, 3);
      continue;
    }
    break;
  }
  return words.join(" ");
}

export function identityTerms(identity: ModelIdentity): string[] {
  const terms = unique([identity.canonicalId, ...identity.aliases])
    .map(normalizeIdentity)
    .filter((value) => value.length > 0);
  // A packaging-stripped form is an additional way to meet the same model, never a replacement:
  // the exact term still has to match first.
  return unique([...terms, ...terms.map(baseIdentity)]);
}

const IDENTITY_PRIORITY: Record<IdentityStatus, number> = {
  unknown: 0,
  unconfirmed: 1,
  codename: 2,
  alias: 3,
  canonical: 4,
};

export function mergeIdentities(left: ModelIdentity, right: ModelIdentity): ModelIdentity {
  const preferred = IDENTITY_PRIORITY[left.status] >= IDENTITY_PRIORITY[right.status] ? left : right;
  return {
    canonicalId: preferred.canonicalId,
    displayName: preferred.displayName,
    aliases: unique([...left.aliases, ...right.aliases, left.canonicalId, right.canonicalId]).filter(
      (value) => value !== preferred.canonicalId,
    ),
    status: preferred.status,
  };
}

/**
 * Which model a name claims to be, reduced to the two things two different models never share: the
 * version and the product line.
 *
 * Title-word overlap cannot see either: it drops one-character words, so `gemini-3.8-flash` is
 * `gemini flash`, all of which `Google: Gemini 3.1 Flash Lite` contains, and on 2026-09-17 that was
 * enough to file Gemini 3.8 Flash under
 * OpenRouter's Gemini 3.1 Flash Lite, with Nano Banana 2 Lite pulled in by alias; 27 of the latest
 * 100 production stories mixed versions the same way (Gemini 2.5 Flash with 3 Flash, Opus 4 with
 * 4.1, GPT-5.2 with 5.5). A name with neither a version nor a line, such as an arena codename, claims
 * nothing and conflicts with nothing.
 */
export type ModelSignature = { version: string | null; lines: string };

/** Words that name a different product at the same version, not a way of serving one. */
const PRODUCT_LINES = new Set([
  "flash",
  "pro",
  "ultra",
  "lite",
  "mini",
  "nano",
  "image",
  "video",
  "audio",
  "tts",
  "edit",
  "omni",
]);

/** "Nano Banana" is Google's brand for Gemini image models, not Gemini Nano. */
function productLines(name: string): string[] {
  const words = normalizeIdentity(name.replace(/nano[\s_-]*banana/gi, " ")).split(" ");
  return [...new Set(words.filter((word) => PRODUCT_LINES.has(word)))].sort();
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function modelSignature(name: string): ModelSignature | null {
  if (UUID_NAME.test(name.trim())) return null;
  // "Google: Gemini 3.1 Flash Lite" and "google/gemini-3.1-flash-lite" name the model after the prefix.
  const words = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^:/]+[:/]\s*/, "")
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  const parts: string[] = [];
  for (const word of words) {
    // `v4.1`, `qwen3.8` and `5.3` carry a version; `64k`, `16k` and `ch3` do not. Four digits and more
    // are snapshot dates (`2511`, `0813`, `20250514`), never a version.
    const leading = parts.length === 0 ? /^[a-z]*(\d{1,2}(?:\.\d{1,2})*)$/.exec(word) : /^(\d{1,2})$/.exec(word);
    if (leading?.[1]) {
      parts.push(...leading[1].split("."));
      continue;
    }
    if (parts.length) break;
  }
  // `gemini-3-8-flash` is 3.8; `Qwen-Image-3.0` is Qwen-Image-3.
  while (parts.length > 1 && Number(parts.at(-1)) === 0) parts.pop();
  const version = parts.length ? parts.map(Number).join(".") : null;
  const lines = productLines(name).join(" ");
  if (version === null && !lines) return null;
  return { version, lines };
}

/**
 * True when two sets of names cannot describe one model: no product line appears on both sides, or
 * both sides name versions and share none. A name without a version bridges nothing: "Gemini Pro
 * Latest" beside Gemini 3 Pro Preview is not a reason to take in gemini-3.1-pro as well.
 */
export function signaturesConflict(left: readonly ModelSignature[], right: readonly ModelSignature[]): boolean {
  if (!left.length || !right.length) return false;
  if (!left.some((one) => right.some((other) => one.lines === other.lines))) return true;
  const versions = (side: readonly ModelSignature[]) =>
    new Set(side.flatMap((one) => (one.version === null ? [] : [one.version])));
  const ours = versions(left);
  const theirs = versions(right);
  return ours.size > 0 && theirs.size > 0 && ![...ours].some((version) => theirs.has(version));
}

/**
 * The signatures of one record's names. A record describes one model, so a product line any of its
 * names carries belongs to all of them: Artificial Analysis keys "Nano Banana (Gemini 2.5 Flash
 * Image)" as `google_gemini-2-5-flash`, and that key alone joined the image model to Gemini 2.5 Flash.
 */
export function identitySignatures(identity: ModelIdentity): ModelSignature[] {
  const names = unique([identity.displayName, identity.canonicalId, ...identity.aliases]);
  const lines = [...new Set(names.flatMap(productLines))].sort().join(" ");
  const signatures = new Map<string, ModelSignature>();
  for (const name of names) {
    const signature = modelSignature(name);
    if (signature) signatures.set(`${signature.version}`, { version: signature.version, lines });
  }
  return [...signatures.values()];
}
