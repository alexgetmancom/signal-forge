import type { Database } from "bun:sqlite";
import { capabilityReport } from "../capabilities.js";
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
 *
 * Three silences, told apart by `state`, because they are three different repairs. A source that
 * stopped is a collector that broke. A source that was asked once and never succeeded is a
 * credential or an upstream that says no. A source that was never asked at all is neither: nothing
 * about its collector is known, and the answer is upstream of it -- on 2026-09-25 `kimi`, `meta`
 * and `bedrock` had `checked_at` null and no collection ever recorded because their capabilities
 * have no credential, and all three read as "gone quiet" here for days. `reason` names that where
 * the registry knows it, and says so plainly when it does not: a registered, credentialled source
 * with no attempt on record is the scheduler, and nothing else in this report would say so.
 */
export type SilentSource = {
  source: string;
  /**
   * `never_polled`: no collection has ever been attempted. `never_succeeded`: attempted and has
   * never once worked. `went_quiet`: it worked, and then stopped.
   */
  state: "never_polled" | "never_succeeded" | "went_quiet";
  /** Why it was never asked, for `never_polled` only. The rest are a collector to open. */
  reason: string | null;
  lastSuccess: string | null;
  lastRecord: string | null;
  quietDays: number | null;
  failures: number;
  lastError: string | null;
};

export function silentSources(db: Database, config: AppConfig, days: number, now = new Date()): SilentSource[] {
  const enabled = buildSourceRegistry(db, config).filter((definition) => definition.enabled);
  // Which capability each source waits on, and what that capability's own report says about it: the
  // difference between "nobody has given this a key" and "this collector is broken".
  const capabilityOf = new Map(
    enabled.flatMap((definition) =>
      definition.requiredCapabilities?.length ? [[definition.id, definition.capabilityId ?? definition.id]] : [],
    ),
  );
  const statusOf = new Map(capabilityReport(db, config).map((entry) => [entry.id, entry.status] as const));
  const reasonFor = (source: string): string | null => {
    const capability = capabilityOf.get(source);
    const status = capability ? statusOf.get(capability) : undefined;
    if (status === "missing") return `capability ${capability} has no credential, so it is never scheduled`;
    if (status === "rejected") return `capability ${capability} was refused upstream and its circuit is open`;
    return "registered, credentialled and never attempted: this is the scheduler, not the collector";
  };
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return enabled
    .map(({ id: source }) => {
      // `checked_at` comes back with the rest of the row rather than in a query of its own: this
      // report reads every enabled source, so each extra statement here is two hundred statements.
      const state = db
        .query<
          { last_success: string | null; last_error: string | null; failures: number; checked_at: string | null },
          [string]
        >("SELECT last_success,last_error,failures,checked_at FROM sources WHERE id=?")
        .get(source);
      const record = db
        .query<{ at: string | null }, [string]>("SELECT MAX(observed_at) at FROM records WHERE source=?")
        .get(source);
      // Attempts, not successes: `checked_at` is stamped by every collection, failed ones included.
      const silence: SilentSource["state"] = !state?.checked_at
        ? "never_polled"
        : state?.last_success
          ? "went_quiet"
          : "never_succeeded";
      const seen =
        [state?.last_success, record?.at]
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1) ?? null;
      return {
        source,
        state: silence,
        reason: silence === "never_polled" ? reasonFor(source) : null,
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
