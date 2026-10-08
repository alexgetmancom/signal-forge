import { text } from "../text.js";
import type { Event } from "./types.js";

type IdentityStatus = "canonical" | "alias" | "codename" | "unconfirmed" | "unknown";

export type ModelIdentity = {
  canonicalId: string | null;
  displayName: string;
  aliases: string[];
  status: IdentityStatus;
};

/**
 * The makers whose version follows the family word, so a two-digit number there is a version with
 * its dot dropped rather than a version past twelve. models.dev writes `gpt-56-sol` for
 * `gpt-5.6-sol`, and a Google docs path writes `gemini-15` for 1.5.
 */
const DOTTED_FAMILY =
  /(^| )(gpt|glm|gemini|grok|qwen|kimi k|minimax m|deepseek [vr]|mistral|magistral|devstral|codestral|claude (?:opus|sonnet|haiku|fable)) (\d)(\d)(?= |$)/g;

/**
 * One spelling of a version, so two spellings of one model are one model.
 *
 * `gpt-5.6-sol` and `gpt-56-sol` are the same release, and counting them apart made fourteen
 * phantom entries in the catalogue by 2026-09-24 -- among them `gpt-52`, `gpt-55-pro` and
 * `gpt-56-terra`, every one of them a model already held under its dotted name. One reached a
 * reader as `glm-53-fast`, and one poisoned the probes, which read `gpt-56-sol` as a model at
 * version 56 and went hunting for `gpt-57`.
 *
 * Only a two-digit number above twelve is read this way, because no family here is past version
 * twelve -- the same rule `familyVersion` states where it refuses one. A number that could be a
 * real version is left alone: `grok-4.20` keeps its twenty, because the dot was never dropped.
 */
function oneSpelling(value: string): string {
  return value.replace(DOTTED_FAMILY, (match, lead: string, family: string, first: string, second: string) =>
    Number(`${first}${second}`) > 12 ? `${lead}${family} ${first} ${second}` : match,
  );
}

/**
 * A zero minor is the version without it.
 *
 * OpenAI's own catalogue lists `gpt-6-sol`, and a Codex issue on 2026-09-29 wrote `gpt-6.0-sol`.
 * Those are two keys for one model, so every rule that asks "do we already know this name" said no,
 * and the radar announced a model that had been callable for a week as something nobody had heard
 * of. No maker has ever shipped 6.0 as a different model from 6. A zero that is part of a longer
 * number is left alone: `gpt 4 05` is a date, and `qwen 2 0 5` would not be 2.5.
 */
const ZERO_MINOR = /(?<=^| )(\d+) 0(?=$| )(?! ?\d)/g;

function withoutZeroMinor(value: string): string {
  return value.replace(ZERO_MINOR, "$1");
}

/**
 * A minor written to two digits is the minor without the padding.
 *
 * `llmux` keys Anthropic's models as `claude-haiku-5-50-20261007` and `claude-fable-5-10-20261007`,
 * which are Haiku 5.5 and Fable 5.1 with the minor padded to two columns. On 2026-10-08 three of
 * them reached the scouts as models nobody had heard of, nine hours after Haiku 5.5 was announced
 * and under a headline saying no catalogue listed it. A trailing zero never changes a version:
 * 5.50 is 5.5 as surely as 6.0 is 6, which is the rule above reading the other column.
 *
 * Anchored to a family name for the same reason `oneSpelling` is: `2026 05 20` and `gpt 4o 2024
 * 11 20` end in the same two digits and are dates, and only the number that directly follows a
 * family word is that family's version. Anchored to Anthropic's four in particular because that is
 * where the padding has been seen. A trailing zero is meaningless arithmetic everywhere,
 * but a maker is free to make it meaningful in a name: `grok-4.20` is xAI's joke and its twenty is
 * written with the dot in place, which `oneSpelling` already leaves alone for the same reason.
 * Anthropic has never shipped a minor past .5, so reading 50 as 5 there risks nothing.
 */
const PADDED_MINOR = /(^| )(claude (?:opus|sonnet|haiku|fable)) (\d+) (\d)0(?= |$)/g;

function withoutPaddedMinor(value: string): string {
  return value.replace(PADDED_MINOR, "$1$2 $3 $4");
}

export function normalizeIdentity(value: string): string {
  return oneSpelling(
    withoutPaddedMinor(
      withoutZeroMinor(
        value
          .normalize("NFKC")
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .replace(/\s+/g, " "),
      ),
    ),
  );
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * The record keys identity is derived from, and the only ones a reader of it needs to fetch.
 *
 * `listStories` used to select `before_json` and `after_json` whole to answer with seven fields per
 * event: 27.6 MB of bodies for a hundred stories, which took 170 MB of a floor that is never given
 * back, measured 2026-09-27. It selects these keys instead. The list is a constant rather than a
 * comment because the SQL that fetches them is generated from it, and `IdentityRecord` below is what
 * makes reading an eighth key here a compile error instead of a silently empty column.
 */
const IDENTITY_KEYS = ["name", "model", "modelKey", "canonical_id", "canonicalId", "modelId", "id"] as const;

/** A record narrowed to what identity reads. `RecordData` satisfies it, so a full record still fits. */
export type IdentityRecord = { [Key in (typeof IDENTITY_KEYS)[number]]?: unknown };

/** The event columns identity reads. An event satisfies it; so does a row that left the bodies behind. */
export type IdentitySubject = Pick<Event, "stream" | "source" | "entity_id">;

/**
 * What the identity columns are named, which `IdentityColumnRow` repeats as a literal type because
 * a template literal type cannot read a constant. The two are checked against each other below.
 */
const IDENTITY_COLUMN_PREFIX = "ident_";

/**
 * The seven keys as SQL columns, read off the same body `recordFor` would have parsed. The row they
 * come from must alias `events` as `e`, which is how every caller already writes it.
 *
 * `COALESCE` picks the body, not the key: taking `name` from the new record and `id` from the old one
 * where only one of them carries each would invent a record neither side ever held. `json_valid`
 * guards a malformed body, which `json_extract` answers with an error where `recordFor` answers with
 * null, and `json_type` keeps the equivalence with `text()`, which reads a string and nothing else --
 * an object arrives from `json_extract` as its own JSON text and would pass for a name.
 */
export function identityColumns(): string {
  const body = "COALESCE(e.after_json,e.before_json)";
  return IDENTITY_KEYS.map(
    (key) =>
      `CASE WHEN json_valid(${body}) AND json_type(${body},'$.${key}')='text' THEN json_extract(${body},'$.${key}') END AS ${IDENTITY_COLUMN_PREFIX}${key}`,
  ).join(",");
}

/** The row those columns make, so a query that forgets one of them does not compile. */
export type IdentityColumnRow = { [Key in (typeof IDENTITY_KEYS)[number] as `ident_${Key}`]: unknown };

/** The record those columns stand for, or null when the row carried none of them. */
export function identityRecordOf(row: IdentityColumnRow): IdentityRecord | null {
  const values = row as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const key of IDENTITY_KEYS) {
    const value = values[`${IDENTITY_COLUMN_PREFIX}${key}`];
    if (value !== null && value !== undefined) record[key] = value;
  }
  return Object.keys(record).length ? (record as IdentityRecord) : null;
}

function displayName(event: IdentitySubject, record: IdentityRecord | null): string {
  return text(record?.name) ?? text(record?.model) ?? event.entity_id;
}

function stableId(record: IdentityRecord | null, event: IdentitySubject): string | null {
  const explicit = text(record?.canonical_id) ?? text(record?.canonicalId);
  if (explicit) return explicit;
  const id = text(record?.id) ?? event.entity_id;
  return event.stream === "packages" ? `${event.source}:${id}` : id;
}

/**
 * The model's own name inside a catalogue id that leads with whoever is serving it.
 *
 * One model is four subjects: `DeepSeek-V4.1-Flash` is published under its own name, and again as
 * `deepseek-ai/DeepSeek-V4.1-Flash`, `microsoft-foundry/DeepSeek-V4.1-Flash` and
 * `azure-ai-foundry/DeepSeek-V4.1-Flash`. The prefixed id is the canonical one for the venue that
 * wrote it -- it is what a reader calls there -- so it stays, and the bare name joins the aliases
 * instead: an alias merges a story where one already holds the name and invents nothing where none
 * does. Measured on 2026-10-07 over the 1587 ids these streams have carried: 929 lead with a host,
 * and 318 of their bare names are subjects in their own right.
 *
 * An alias is scoped by the vendor a story is filed under, and a vendor is read off the name before
 * the host, so the four above agree on DeepSeek and merge. Where the bare name says nothing about
 * its maker the merge rests on the prefix alone -- and of the 45 such names, every one arrives with
 * exactly one prefix and one maker, so no two makers can meet over a shared tail in the history
 * this has. `signaturesConflict` still keeps two versions apart.
 *
 * Only the first segment goes, so what follows it is left to say what it is: the alias of
 * `nvidia/GLM-5.3-Flash-NVFP4` is `GLM-5.3-Flash-NVFP4` and not the model it quantises. `packages`
 * is excluded above because `stableId` prefixes its id with its own registry, and the segment after
 * that is a scope rather than a name.
 */
function withoutTheHostsPrefix(id: string | null): string | null {
  if (!id?.includes("/")) return null;
  const tail = id.split("/").slice(1).join("/");
  return tail.length > 1 ? tail : null;
}

/**
 * Derives identity only from evidence already present in the record. A leaderboard key is never
 * promoted to a canonical model ID: it remains a codename until another source identifies it.
 */
export function identityFor(event: IdentitySubject, record: IdentityRecord | null): ModelIdentity {
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

  if (event.stream === "packages") {
    return {
      canonicalId: id,
      displayName: name,
      aliases: unique([name, id]).filter((value) => value !== id),
      status: id ? "canonical" : "unknown",
    };
  }

  if (["api-models", "openrouter", "weights"].includes(event.stream)) {
    return {
      canonicalId: id,
      displayName: name,
      aliases: unique([name, id, withoutTheHostsPrefix(id)]).filter((value) => value !== id),
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
