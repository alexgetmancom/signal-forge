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
 */
export type FlakySource = {
  id: string;
  label: string;
  attempts: number;
  failures: number;
  failureRate: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  /** Hours since the last success, which says whether the intermittency is still intermittent. */
  quietHours: number | null;
  lastError: string | null;
  /** `failing` when nothing has succeeded in the window, `flaky` when both outcomes occur. */
  state: "failing" | "flaky";
};

/** Below this the intermittency is the upstream's own weather rather than a fault worth naming. */
const NOTABLE_FAILURE_RATE = 0.1;
/** Too few attempts to read a rate from: two failures out of three is not evidence of anything. */
const MINIMUM_ATTEMPTS = 8;

export function flakySources(db: Database, config: AppConfig, days = 3, now = Date.now()): FlakySource[] {
  const from = new Date(now - days * 24 * 3_600_000).toISOString();
  const registry = new Map(
    buildSourceRegistry(db, config)
      .filter((definition) => definition.enabled)
      .map((definition) => [definition.id, definition.label]),
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

  const errors = db.query<{ last_error: string | null }, [string]>("SELECT last_error FROM sources WHERE id=?");
  return rows
    .filter((row) => registry.has(row.source))
    .map((row) => {
      const failureRate = row.failures / row.attempts;
      return {
        id: row.source,
        label: registry.get(row.source) ?? row.source,
        attempts: row.attempts,
        failures: row.failures,
        failureRate: Math.round(failureRate * 100) / 100,
        lastSuccess: row.last_success,
        lastFailure: row.last_failure,
        quietHours: row.last_success ? Math.floor((now - Date.parse(row.last_success)) / 3_600_000) : null,
        lastError: errors.get(row.source)?.last_error ?? null,
        state: row.failures === row.attempts ? ("failing" as const) : ("flaky" as const),
      };
    })
    .filter(
      (entry) => entry.failures > 0 && entry.attempts >= MINIMUM_ATTEMPTS && entry.failureRate >= NOTABLE_FAILURE_RATE,
    )
    .sort((left, right) => right.failureRate - left.failureRate || right.failures - left.failures);
}
