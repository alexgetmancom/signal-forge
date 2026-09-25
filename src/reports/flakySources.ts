import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * Sources that fail often but not always -- the third kind of broken, and the one nothing reported.
 *
 * `issues` reads the current state: a source is listed when `sources.failures` is standing above
 * zero right now. `silent-sources` reads absence: nothing collected, nothing recorded. Between them
 * sits a source that fails two attempts in three and succeeds on the third, which resets the
 * counter and writes a record. It is never silent and it is only red if somebody looks in the minute
 * it happens to be.
 *
 * Measured on production 2026-09-25: `arena` failed 136 of 187 attempts over three days, 73%, while
 * appearing in `issues` only intermittently and never in `silent-sources`. `vercel-gateway` was at
 * 204 of 235 and `claude-web` at 15 of 24. None of the three had been noticed, and `arena` carries
 * the codenames and the leaderboards.
 *
 * The rate lives in `source_collection_metrics`, which no report read. This reads it, through the
 * registry, so a retired source does not appear as a broken one.
 *
 * One rate was not enough. Of `arena`'s 103 failures in the three days to 2026-09-25, 84 were this
 * service's own shrink guard refusing a short answer -- `suspiciousShrink` doing exactly its job,
 * counted here as a fault and reported as 58%. A refusal we chose and a collector that cannot read
 * the page are different news for different people, so the failures are now broken down by the kind
 * carried on the error, and the headline is the rate excluding our own refusals.
 */
export type FlakySource = {
  id: string;
  label: string;
  /**
   * The pacing group, which is a host name, or the registry group when there is none.
   *
   * Here so that five rows sharing one do not read as five unrelated collectors. `outages` is the
   * aggregate; this is the hint that sends you to it.
   */
  group: string;
  attempts: number;
  failures: number;
  failureRate: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  /** Hours since the last success, which says whether the intermittency is still intermittent. */
  quietHours: number | null;
  lastError: string | null;
  lastErrorKind: string | null;
  /** How many failures of each kind, from `failure_kind`. See src/failure.ts for what each means. */
  kinds: Record<string, number>;
  /** Failures this service chose: the shrink guard refusing an answer to protect what is stored. */
  refusedByGuard: number;
  /** Failures that are not our own refusal -- the number worth acting on. */
  faults: number;
  faultRate: number;
  /**
   * `failing` when nothing succeeded in the window, `guarded` when the refusals are mostly ours,
   * `flaky` when the upstream is genuinely intermittent.
   */
  state: "failing" | "guarded" | "flaky";
};

/** Below this the intermittency is the upstream's own weather rather than a fault worth naming. */
const NOTABLE_FAILURE_RATE = 0.1;
/** Above this share of the failures being our own guard, the source is refused rather than broken. */
const MOSTLY_GUARDED = 0.5;
/** Too few attempts to read a rate from: two failures out of three is not evidence of anything. */
const MINIMUM_ATTEMPTS = 8;

export function flakySources(db: Database, config: AppConfig, days = 3, now = Date.now()): FlakySource[] {
  const from = new Date(now - days * 24 * 3_600_000).toISOString();
  const registry = new Map(
    buildSourceRegistry(db, config)
      .filter((definition) => definition.enabled)
      .map((definition) => [
        definition.id,
        { label: definition.label, group: definition.pace?.group ?? definition.group },
      ]),
  );
  const rows = db
    .query<
      {
        source: string;
        attempts: number;
        failures: number;
        last_success: string | null;
        last_failure: string | null;
      },
      [string]
    >(
      `SELECT source,
              COUNT(*) AS attempts,
              SUM(success = 0) AS failures,
              MAX(CASE WHEN success = 1 THEN collected_at END) AS last_success,
              MAX(CASE WHEN success = 0 THEN collected_at END) AS last_failure
       FROM source_collection_metrics
       WHERE collected_at >= ?
       GROUP BY source`,
    )
    .all(from);
  // Rows written before migration 052 carry no kind. The guard's own refusals are still recognisable
  // in them by the sentence it writes, and reading that here rather than in the poller keeps the
  // recognition where a wrong guess costs a mislabelled report instead of a leaked response body.
  const kindRows = db
    .query<{ source: string; kind: string; failures: number }, [string]>(
      `SELECT source,
              COALESCE(failure_kind, CASE WHEN error LIKE 'Collection degraded:%' THEN 'degraded' ELSE 'unrecorded' END)
                AS kind,
              COUNT(*) AS failures
       FROM source_collection_metrics
       WHERE collected_at >= ? AND success = 0
       GROUP BY source, kind`,
    )
    .all(from);
  const byKind = new Map<string, Record<string, number>>();
  for (const row of kindRows) {
    const kinds = byKind.get(row.source) ?? {};
    kinds[row.kind] = row.failures;
    byKind.set(row.source, kinds);
  }

  const errors = db.query<{ last_error: string | null; last_error_kind: string | null }, [string]>(
    "SELECT last_error,last_error_kind FROM sources WHERE id=?",
  );
  return (
    rows
      .filter((row) => registry.has(row.source))
      .map((row) => {
        const failureRate = row.failures / row.attempts;
        const kinds = byKind.get(row.source) ?? {};
        const refusedByGuard = kinds.degraded ?? 0;
        const faults = row.failures - refusedByGuard;
        const stored = errors.get(row.source);
        return {
          id: row.source,
          label: registry.get(row.source)?.label ?? row.source,
          group: registry.get(row.source)?.group ?? row.source,
          attempts: row.attempts,
          failures: row.failures,
          failureRate: Math.round(failureRate * 100) / 100,
          lastSuccess: row.last_success,
          lastFailure: row.last_failure,
          quietHours: row.last_success ? Math.floor((now - Date.parse(row.last_success)) / 3_600_000) : null,
          lastError: stored?.last_error ?? null,
          lastErrorKind: stored?.last_error_kind ?? null,
          kinds,
          refusedByGuard,
          faults,
          faultRate: Math.round((faults / row.attempts) * 100) / 100,
          state:
            row.failures === row.attempts
              ? ("failing" as const)
              : refusedByGuard > row.failures * MOSTLY_GUARDED
                ? ("guarded" as const)
                : ("flaky" as const),
        };
      })
      .filter(
        (entry) =>
          entry.failures > 0 && entry.attempts >= MINIMUM_ATTEMPTS && entry.failureRate >= NOTABLE_FAILURE_RATE,
      )
      // Real faults first, then our own refusals: a collector that cannot read the page is somebody's
      // morning, and a guard doing its job is a note.
      .sort((left, right) => right.faultRate - left.faultRate || right.failureRate - left.failureRate)
  );
}
