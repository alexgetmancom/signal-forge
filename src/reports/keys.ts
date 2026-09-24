import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { openCredentialCircuits } from "../credentials.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * Which credentials a deployment is short of, by the name of the setting rather than its value.
 *
 * `capabilities` answers whether an integration is ready and counts what it lacks; it cannot say
 * which setting to write, so acting on it meant reading the registry by hand. This names the
 * settings, says whether one is absent or was refused, and says what stopped collecting because
 * of it -- the three things needed to fix a key and nothing else.
 *
 * Asked when someone is about to supply a key. It is deliberately not part of any opening ritual:
 * a missing credential is a standing fact about a deployment, and a report that recites it at the
 * top of every session teaches its reader to skip the one time it changed.
 *
 * Values never appear. The names are the names of settings, which a config file and a deployment
 * log already carry, and `detail` on a refusal comes from the circuit, which stores the upstream's
 * status rather than its body.
 */
type KeyStanding = {
  capability: string;
  status: "missing" | "rejected" | "ready";
  /** The settings that are not filled in, by name. */
  missing: string[];
  /** Every setting this capability needs, by name, whether or not it is filled in. */
  required: string[];
  /** Sources that are not being collected because of this. */
  blocks: string[];
  refusal?: { statusCode: number | null; source: string; rejections: number; since: string; lastAt: string };
};

export type KeyReport = {
  needAttention: KeyStanding[];
  ready: string[];
  /** Enabled sources not collecting for want of a credential, counted once. */
  sourcesBlocked: number;
};

export function keyStandings(db: Database, config: AppConfig, scope: "attention" | "all"): KeyReport {
  const required = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  const note = (capability: string, names: readonly string[], source: string): void => {
    const names_ = required.get(capability) ?? new Set<string>();
    for (const name of names) names_.add(name);
    required.set(capability, names_);
    const owned = sources.get(capability) ?? new Set<string>();
    owned.add(source);
    sources.set(capability, owned);
  };
  for (const definition of buildSourceRegistry(db, config)) {
    const names = definition.requiredCapabilities ?? [];
    if (names.length && definition.enabled) note(definition.capabilityId ?? definition.id, names, definition.id);
  }
  if (config.destinations.some((destination) => destination.platform === "telegram"))
    note("telegram", ["TELEGRAM_BOT_TOKEN"], "telegram");
  if (config.destinations.some((destination) => destination.platform === "discord"))
    note("discord", ["DISCORD_BOT_TOKEN"], "discord");

  const values = config as unknown as Record<string, unknown>;
  const refusals = new Map(openCredentialCircuits(db).map((circuit) => [circuit.capabilityId, circuit]));
  const standings = [...required.entries()]
    .map(([capability, names]): KeyStanding => {
      const missing = [...names].filter((name) => !values[name]).sort();
      const refusal = refusals.get(capability);
      return {
        capability,
        status: missing.length ? "missing" : refusal ? "rejected" : "ready",
        missing,
        required: [...names].sort(),
        blocks: missing.length || refusal ? [...(sources.get(capability) ?? [])].sort() : [],
        ...(refusal && !missing.length
          ? {
              refusal: {
                statusCode: refusal.statusCode,
                source: refusal.source,
                rejections: refusal.rejections,
                since: refusal.openedAt,
                lastAt: refusal.lastRejectedAt,
              },
            }
          : {}),
      };
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
  const needAttention = standings.filter((standing) => standing.status !== "ready");
  return {
    needAttention: scope === "all" ? standings : needAttention,
    ready: standings.filter((standing) => standing.status === "ready").map((standing) => standing.capability),
    sourcesBlocked: new Set(needAttention.flatMap((standing) => standing.blocks)).size,
  };
}
