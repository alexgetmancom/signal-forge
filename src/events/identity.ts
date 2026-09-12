import { text } from "../text.js";
import type { Event, RecordData } from "./types.js";

export type IdentityStatus = "canonical" | "alias" | "codename" | "unconfirmed" | "unknown";

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
