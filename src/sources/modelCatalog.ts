import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { fetchText } from "./http.js";

/**
 * The model catalogue Claude's own clients read, which is the first-party answer to what each
 * surface offers before anyone announces it.
 *
 * It is published in the configuration documentation for third-party Desktop, signed, and it moves:
 * version 1478 on 2026-10-01 and 1588 a day later. What it says and what `/v1/models` says are
 * different questions -- `claude-opus-4-1-20250805` is offered here and is not in this account's API
 * answer -- so this is read as what a client is offered, never as what an account may call.
 *
 * It is also 147 KB against the 22 MB of reading claude.ai's bundles for the same question, and it
 * is not behind the bot protection that answers that host 403 to anyone anonymous.
 */
const CATALOG = "https://downloads.claude.ai/model-catalog/v1/catalog.json";
const SIGNATURE = `${CATALOG}.raw-sig.json`;

/**
 * The key Claude Code carries to check this catalogue, read out of the 2.1.286 distribution and
 * pinned here. The signature document names the key it was made with by the SHA-256 of its DER,
 * which is computed from this one rather than written down beside it.
 *
 * Pinned rather than taken from the signature, because a signature that names its own key proves
 * only that whoever wrote the document also wrote the signature. If the publisher rotates this,
 * the collector fails loudly and somebody reads the new distribution; it must never quietly trust
 * a key the document brought with it.
 */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAp28rSV5I8HmK8CK9GixB
UZR/gtJxeOCsRXO4EJiej40jzBmQA3cWXGosVO82ZfFsRKVTtMC5iB/HH9sxjncr
mYNWGroJNbx29m/FgYQBgkCXT4AfFl6rnnXqRGLZOerj/4AqE4yQ1GZbhBgR55Z7
ro0ieKK8RHYUspBKAFHyWRhCCz6THW6YRbf0p/hG/08TOY6Sj3cJ7/AEoTRf9ZmV
NX1k0KvbUSiVGpGY9OIHWgxRJUF2pArU4o/hk+sqGAgEUh8Bjvjwvz6+quLXPg+y
0Y8Ugb1Fg6BUppam/zydYY/Q/+yNjnuF154gD1jEeeir8R5czs6zUHSbo2yXUpAs
IdWYo5End8vGsluVmFExnUWm/fTVMGoM5Wm3v1VRepMydEnJ+atz4oQdmPQcKNAi
p5GJO2uyk++xFr9CpKvlR5jral92toYV/m+mur3va8ydamWBo/qG7/wt0sdS81Iw
H6lcu0SQ39rgKD+bdoPLv05EqVMYTFRI2QZEsWGYTMs0DOrfCIJFH50qyD0x4sWw
1gEWeG3jDgY8cj2StZz+zjqzUd05CibcCzEAGm1EQg5y9D40tIsAU1OI7bpgQ9V0
lC8lrqE7zJY66UK9Z1daA8jrdDi6migNjHFrXfT3V4QvMthCIO05q05SS3x2G3Zp
IgmI+CePUPB1pDf+lhPkU1MCAwEAAQ==
-----END PUBLIC KEY-----`;
/** What is signed: this label, one NUL byte, then the catalogue's own bytes. */
const LABEL = "claude-code-model-catalog-v1";

/** The key above, as the signature document names it: SHA-256 over its DER. Derived, so the two cannot drift. */
function keyDigest(spki: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(spki).digest("hex");
}

const signatureSchema = z.object({
  algorithm: z.literal("RSASSA-PKCS1-v1_5-SHA512"),
  signature: z.string().min(1),
  publicKeySha256: z.string().min(1),
});
const thinkingSchema = z
  .object({
    type: z.string().nullish(),
    effort_options: z.array(z.object({ id: z.string() })).nullish(),
  })
  .nullish();
const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  section: z.string().nullish(),
  capabilities: z.record(z.string(), z.boolean()).nullish(),
  thinking: thinkingSchema,
});
const surfaceSchema = z.object({
  model_selector_state: z.array(z.object({ model: z.string().nullish(), thinking: thinkingSchema })).min(1),
  model_selector_config: z.array(z.object({ models: z.array(modelSchema).default([]) })).min(1),
});
const catalogSchema = z.object({
  schema_version: z.union([z.string(), z.number()]).nullish(),
  version: z.number().int().nonnegative(),
  issued_at: z.string().min(1),
  expires_at: z.string().min(1),
  key_id: z.string().min(1),
  surfaces: z.record(z.string(), surfaceSchema),
});
type Catalog = z.infer<typeof catalogSchema>;

async function verifySignature(body: string, document: string): Promise<void> {
  const signature = signatureSchema.safeParse(JSON.parse(document));
  if (!signature.success) throw new SourceError("schema", "The catalogue signature is not the document it was");
  const pem = PUBLIC_KEY.replace(/-----[^-]+-----|\s/g, "");
  const spki = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  // A key this service does not hold is a rotation, and a rotation is read from the distribution by
  // somebody rather than accepted from the document that would benefit from it.
  if (signature.data.publicKeySha256 !== keyDigest(spki))
    throw new SourceError("protocol", "The catalogue names a signing key this service does not hold");
  const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, false, [
    "verify",
  ]);
  // The bytes served are the bytes signed. JSON over HTTP is UTF-8, so encoding what was read back
  // reproduces them; a body where it did not would fail here rather than pass unchecked.
  const label = new TextEncoder().encode(LABEL);
  const bytes = new TextEncoder().encode(body);
  const signed = new Uint8Array(label.length + 1 + bytes.length);
  signed.set(label);
  signed[label.length] = 0;
  signed.set(bytes, label.length + 1);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(atob(signature.data.signature), (c) => c.charCodeAt(0)),
    signed,
  );
  if (!verified) throw new SourceError("protocol", "The catalogue signature does not verify against the pinned key");
}

/** The version a previous poll stored, so a CDN serving an older document cannot undo a reading. */
function previousVersion(db: Database, source: string): number | null {
  const stored = readLatestSnapshot(db, source);
  if (!stored) return null;
  try {
    return catalogSchema.partial().parse(JSON.parse(stored)).version ?? null;
  } catch {
    return null;
  }
}

/** The names a model's capability map says yes to, which is the part that moves. */
function enabled(capabilities: Record<string, boolean> | null | undefined): string[] {
  return Object.entries(capabilities ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort();
}

/**
 * One record per model, carrying the surfaces that offer it rather than one record per pair: a model
 * reaching a sixth surface is the same model, and five records for one release would be five cards.
 */
function modelRecords(catalog: Catalog): RecordData[] {
  const byId = new Map<
    string,
    { name: string; surfaces: Set<string>; sections: Set<string>; caps: Set<string>; effort: Set<string> }
  >();
  for (const [surface, body] of Object.entries(catalog.surfaces)) {
    for (const model of body.model_selector_config[0]?.models ?? []) {
      const seen = byId.get(model.id) ?? {
        name: model.name ?? model.id,
        surfaces: new Set<string>(),
        sections: new Set<string>(),
        caps: new Set<string>(),
        effort: new Set<string>(),
      };
      seen.surfaces.add(surface);
      if (model.section) seen.sections.add(model.section);
      for (const name of enabled(model.capabilities)) seen.caps.add(name);
      for (const option of model.thinking?.effort_options ?? []) seen.effort.add(option.id);
      byId.set(model.id, seen);
    }
  }
  return [...byId].map(([id, seen]) => ({
    id,
    name: seen.name,
    maker: "Anthropic",
    offeredOn: [...seen.surfaces].sort(),
    ...(seen.sections.size ? { sections: [...seen.sections].sort() } : {}),
    ...(seen.caps.size ? { capabilities: [...seen.caps].sort() } : {}),
    ...(seen.effort.size ? { effortLevels: [...seen.effort].sort() } : {}),
  }));
}

/** One record per surface for what it opens on, which moves on its own and before a model list does. */
function surfaceRecords(catalog: Catalog): RecordData[] {
  return Object.entries(catalog.surfaces).map(([surface, body]) => {
    const state = body.model_selector_state[0];
    return {
      id: `surface:${surface}`,
      name: `Claude ${surface}: default model`,
      maker: "Anthropic",
      ...(state?.model ? { defaultModel: state.model } : {}),
      ...(state?.thinking?.type ? { defaultThinking: state.thinking.type } : {}),
    };
  });
}

export async function collectClaudeModelCatalog(
  db: Database,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<Collection> {
  const body = await fetchText(CATALOG, {}, request);
  await verifySignature(body, await fetchText(SIGNATURE, {}, request));
  const catalog = catalogSchema.parse(JSON.parse(body));
  // An expired document is the publisher having stopped refreshing it, and reading one as current
  // would report last month's line-up as today's.
  if (Date.parse(catalog.expires_at) < now)
    throw new SourceError("protocol", "The published catalogue expired before it was read");
  const previous = previousVersion(db, "claude-model-catalog");
  if (previous !== null && catalog.version < previous)
    throw new SourceError("degraded", `The catalogue went back ${previous - catalog.version} versions`);
  return {
    source: "claude-model-catalog",
    stream: "api-models",
    url: CATALOG,
    raw: catalog,
    records: [...modelRecords(catalog), ...surfaceRecords(catalog)],
  };
}
