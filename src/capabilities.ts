import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { openCredentialCircuitIds } from "./credentials.js";
import { buildSourceRegistry } from "./sources/registry.js";

/**
 * `rejected` is a credential that is present and was refused by the upstream. It reads differently
 * from `missing` on purpose: nothing needs to be supplied, something needs to be replaced.
 */
type CapabilityStatus = "ready" | "missing" | "disabled" | "rejected";

export type CapabilityReportEntry = {
  id: string;
  status: CapabilityStatus;
  missingCount: number;
  requiredCount: number;
  enabledSources: string[];
};

type CapabilityState = {
  required: Set<string>;
  enabledSources: Set<string>;
  enabled: boolean;
};

/**
 * Reports only readiness metadata. The registry decides which source integrations are intentional;
 * values themselves never leave config or enter this read model.
 */
export function capabilityReport(db: Database, config: AppConfig): CapabilityReportEntry[] {
  const states = new Map<string, CapabilityState>();
  const add = (id: string, required: readonly string[], enabled: boolean, source: string): void => {
    const state = states.get(id) ?? { required: new Set<string>(), enabledSources: new Set<string>(), enabled: false };
    for (const name of required) state.required.add(name);
    state.enabled ||= enabled;
    if (enabled) state.enabledSources.add(source);
    states.set(id, state);
  };

  for (const definition of buildSourceRegistry(db, config)) {
    const required = definition.requiredCapabilities ?? [];
    if (required.length) add(definition.capabilityId ?? definition.id, required, definition.enabled, definition.id);
  }

  const telegramEnabled = config.destinations.some((destination) => destination.platform === "telegram");
  const discordEnabled = config.destinations.some((destination) => destination.platform === "discord");
  add("telegram", ["TELEGRAM_BOT_TOKEN"], telegramEnabled, "telegram");
  add("discord", ["DISCORD_BOT_TOKEN"], discordEnabled, "discord");

  const values = config as unknown as Record<string, unknown>;
  const rejected = openCredentialCircuitIds(db);
  return [...states.entries()]
    .map(([id, state]) => {
      const missingCount = [...state.required].filter((name) => !values[name]).length;
      return {
        id,
        status: !state.enabled ? "disabled" : missingCount ? "missing" : rejected.has(id) ? "rejected" : "ready",
        missingCount,
        requiredCount: state.required.size,
        enabledSources: [...state.enabledSources].sort(),
      } satisfies CapabilityReportEntry;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
