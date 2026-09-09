import type { Event, RecordData } from "./types.js";

export type IdentityStatus = "canonical" | "alias" | "codename" | "unconfirmed" | "unknown";

export type ModelIdentity = {
  canonicalId: string | null;
  displayName: string;
  aliases: string[];
  status: IdentityStatus;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

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

export function identityTerms(identity: ModelIdentity): string[] {
  return unique([identity.canonicalId, ...identity.aliases])
    .map(normalizeIdentity)
    .filter((value) => value.length > 0);
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
