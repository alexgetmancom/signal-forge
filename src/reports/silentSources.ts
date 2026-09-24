import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * Enabled sources that have gone quiet, and the last thing each of them said.
 *
 * A source that fails loudly is in `issues`. A source that stopped without failing is in nothing:
 * `arena` last succeeded on 2026-09-19 and four designarena boards last recorded anything on
 * 2026-09-09, and both went unnoticed for days because every surface reads the latest collection
 * rather than the absence of one. Silence is the reading: last success, last record observed, and
 * the error sitting on the source if it has one.
 */
export type SilentSource = {
  source: string;
  lastSuccess: string | null;
  lastRecord: string | null;
  quietDays: number | null;
  failures: number;
  lastError: string | null;
};

export function silentSources(db: Database, config: AppConfig, days: number, now = new Date()): SilentSource[] {
  const enabled = buildSourceRegistry(db, config)
    .filter((definition) => definition.enabled)
    .map((definition) => definition.id);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return enabled
    .map((source) => {
      const state = db
        .query<{ last_success: string | null; last_error: string | null; failures: number }, [string]>(
          "SELECT last_success,last_error,failures FROM sources WHERE id=?",
        )
        .get(source);
      const record = db
        .query<{ at: string | null }, [string]>("SELECT MAX(observed_at) at FROM records WHERE source=?")
        .get(source);
      const seen =
        [state?.last_success, record?.at]
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1) ?? null;
      return {
        source,
        lastSuccess: state?.last_success ?? null,
        lastRecord: record?.at ?? null,
        quietDays: seen ? Math.floor((now.getTime() - Date.parse(seen)) / 86_400_000) : null,
        failures: state?.failures ?? 0,
        lastError: state?.last_error ?? null,
      };
    })
    .filter((row) => !row.lastSuccess || (row.lastSuccess < cutoff && (row.lastRecord ?? "") < cutoff))
    .sort((a, b) => (a.lastSuccess ?? "").localeCompare(b.lastSuccess ?? ""));
}
