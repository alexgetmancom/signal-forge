import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { openCredentialCircuitIds } from "../credentials.js";
import { SOURCE_AUTHORITIES } from "../events/confidence.js";
import { measure } from "../runtime/metrics.js";
import { HttpCache } from "../storage/httpCache.js";
import type { SourceDefinition, SourceEntry } from "./definition.js";
import { GITHUB_DISCOVERY_QUERIES } from "./discovery.js";
import { sourceLabel } from "./labels.js";
import { cataloguesSources } from "./packs/catalogues.js";
import { communitySources } from "./packs/community.js";
import { leaderboardsSources } from "./packs/leaderboards.js";
import { lifecycleSources } from "./packs/lifecycle.js";
import { newsSources } from "./packs/news.js";
import { webSources } from "./packs/web.js";

export type { SourceDefinition } from "./definition.js";

/**
 * The one source catalog used to wire polling and status. Dynamic families are still generated
 * from their collector-specific lists, and every entry lives in a source pack under
 * sources/packs/, one file per kind of source. This joins the packs and derives what an entry may not
 * set for itself.
 */
export function buildSourceRegistry(db: Database, config: AppConfig): SourceDefinition[] {
  const context = { db, config, cache: new HttpCache(db) };
  // Label and enabled derive from the id, so an entry cannot name one source and switch another.
  const definitions: SourceEntry[] = [
    ...cataloguesSources(context),
    ...newsSources(context),
    ...communitySources(context),
    ...leaderboardsSources(context),
    ...webSources(context),
    ...lifecycleSources(context),
  ];

  const shadowByDefault = new Set<string>([
    "github:openai/codex:pulls",
    "github:openai/codex:commits",
    ...GITHUB_DISCOVERY_QUERIES.map((query) => `discovery:github-${query.id}`),
    // Two aggregators of other people's catalogues, kept out of the channel until a fortnight of
    // signal-quality says what they are worth. They are the only sight of the cloud deployment
    // layer, and also the only sources here that report a launch without the vendor saying so.
    "models-dev",
    "truefoundry-azure",
    // An engineering blog, not a newsroom. "Async GRPO with LoRA across HF Jobs" is a post about
    // how Hugging Face runs training on its own infrastructure; a reader following model releases
    // gets nothing from it, and it arrived in the invited room beside actual sightings. The feed
    // keeps collecting, because a release post could appear there and the evidence is worth
    // holding; it simply no longer interrupts anyone.
    "huggingface-blog-feed",
    // Collected to be measured against, never to be told: nobody needs a card because a model
    // moved from ninth to tenth by tokens.
    "openrouter-usage",
    // The first source here that observes nobody's product: strangers betting on what ships. It
    // collects so that `lead-time` and `source-verdicts` can answer, after a fortnight of its own
    // data, whether a market ever named a model before this feed saw one. Until they do, nothing
    // it records reaches a reader.
    "polymarket",
    // An API specification and a generated SDK name a model for a machine before a vendor names it
    // for a reader. Unproven against the catalogues, so they collect and tell nobody until
    // `lead-time` has a fortnight of their own data to answer with.
    "github:openai/openai-openapi:commits",
    "github:anthropics/anthropic-sdk-typescript:commits",
    // Removed on 2026-09-10 as mostly marketing, back to be measured rather than trusted: it
    // collects, never reaches a channel, and source-verdicts decides after a month.
    "nvidia-developer-blog",
  ]);
  const resolved = definitions.map(
    (definition): SourceDefinition => ({
      ...definition,
      label: sourceLabel(definition.id),
      enabled: config.sourceEnabled[definition.id] ?? true,
      mode: config.sourceMode[definition.id] ?? (shadowByDefault.has(definition.id) ? "shadow" : "active"),
    }),
  );
  const observed = resolved.map(
    (definition): SourceDefinition => ({
      ...definition,
      collector: () => measure(db, `source.collect:${definition.id}`, definition.collector),
    }),
  );
  validateSourceRegistry(observed);
  return observed;
}

export function validateSourceRegistry(definitions: readonly SourceDefinition[]): void {
  const ids = new Set<string>();
  const pacing = new Map<string, number>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate source ID: ${definition.id}`);
    ids.add(definition.id);
    if (!definition.label.trim()) throw new Error(`Source ${definition.id} has no label`);
    if (!definition.group.trim()) throw new Error(`Source ${definition.id} has no group`);
    if (!SOURCE_AUTHORITIES.includes(definition.authority))
      throw new Error(`Source ${definition.id} has invalid authority`);
    // Without a vendor a first-party surface counts as an independent witness to its own vendor.
    if (definition.authority === "first_party" && !definition.vendor?.trim())
      throw new Error(`Source ${definition.id} is first-party and names no vendor`);
    if (definition.mode !== "active" && definition.mode !== "shadow")
      throw new Error(`Source ${definition.id} has invalid mode`);
    if (!Number.isInteger(definition.intervalSeconds) || definition.intervalSeconds <= 0)
      throw new Error(`Source ${definition.id} has an invalid interval`);
    if (definition.pace) {
      if (!definition.pace.group.trim() || !Number.isInteger(definition.pace.seconds) || definition.pace.seconds <= 0)
        throw new Error(`Source ${definition.id} has invalid pacing`);
      const previous = pacing.get(definition.pace.group);
      if (previous !== undefined && previous !== definition.pace.seconds)
        throw new Error(`Pacing group ${definition.pace.group} has conflicting intervals`);
      pacing.set(definition.pace.group, definition.pace.seconds);
    }
  }
}

/**
 * Stores who each source answers for, and with what authority, as the registry says, so projections
 * rebuilt from stored rows read the values the poller collected with rather than a second list.
 */
export function recordSourceIdentities(db: Database, definitions: readonly SourceDefinition[]): void {
  const upsert = db.query(
    "INSERT INTO sources(id,authority,vendor) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET authority=excluded.authority,vendor=excluded.vendor",
  );
  for (const definition of definitions) upsert.run(definition.id, definition.authority, definition.vendor ?? null);
}

/** Scheduler projection: all operational metadata still comes from buildSourceRegistry. */
export function sourceJobs(db: Database, config: AppConfig): SourceDefinition[] {
  const rejected = openCredentialCircuitIds(db);
  return buildSourceRegistry(db, config).filter(
    (definition) =>
      definition.enabled &&
      sourceRequirementsReady(definition, config) &&
      !rejected.has(definition.capabilityId ?? definition.id),
  );
}

export function sourceRequirementsReady(definition: SourceDefinition, config: AppConfig): boolean {
  return (definition.requiredCapabilities ?? []).every((name) => Boolean(config[name]));
}
