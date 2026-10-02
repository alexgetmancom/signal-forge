/**
 * What state every configured source is in, and why, in one reading.
 *
 * The status board draws this and `issues` asserts on it, so nothing here formats anything: the
 * words a reader sees are one file over, and a change to them is not a change to this answer.
 */

import type { Database } from "bun:sqlite";
import type { AppConfig, SourceMode } from "../config.js";
import type { SourceAuthority } from "../events/types.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * A source can be silent for several different reasons, and a status board that calls all of them
 * "down" teaches readers to ignore it. Blocked is not broken: Gemini answers everywhere except
 * the addresses this project can reach, so it is reported as a restriction with its cause, not a fault.
 */
export type SourceState = "ok" | "stale" | "failing" | "degraded" | "blocked" | "idle" | "missing" | "disabled";

export type SourceHealth = {
  id: string;
  label: string;
  group: string;
  upstream: string | null;
  authority: SourceAuthority;
  mode: SourceMode;
  state: SourceState;
  detail: string;
  lastSuccess: string | null;
  checkedAt: string | null;
};

/** A source is late once it has missed three of its own intervals — one slow cycle is not news. */
export function sourceHealth(db: Database, config: AppConfig, now = Date.now()): SourceHealth[] {
  return buildSourceRegistry(db, config).map((source) => {
    const sourceBase = {
      id: source.id,
      label: source.label,
      group: source.group,
      upstream: source.upstream ?? (source.pace?.group.includes(".") ? source.pace.group : null),
      authority: source.authority,
      mode: source.mode,
    };
    const missing = (source.requiredCapabilities ?? []).filter((name) => !config[name]);
    if (!source.enabled)
      return {
        ...sourceBase,
        state: "disabled",
        detail: "disabled by configuration",
        lastSuccess: null,
        checkedAt: null,
      } satisfies SourceHealth;
    if (missing.length)
      return {
        ...sourceBase,
        state: "missing",
        detail: `missing ${missing.join(", ")}`,
        lastSuccess: null,
        checkedAt: null,
      } satisfies SourceHealth;

    const row = db
      .query<
        {
          last_success: string | null;
          last_error: string | null;
          last_error_kind: string | null;
          checked_at: string | null;
          retry_at: string | null;
        },
        [string]
      >("SELECT last_success,last_error,last_error_kind,checked_at,retry_at FROM sources WHERE id=?")
      .get(source.id);
    const group = source.group;
    const restriction = source.restrictedReason;

    if (!row?.checked_at)
      return {
        ...sourceBase,
        group,
        state: "idle",
        detail: "no observation yet",
        lastSuccess: row?.last_success ?? null,
        checkedAt: row?.checked_at ?? null,
      };
    const observationBase = { lastSuccess: row.last_success, checkedAt: row.checked_at };
    if (row.last_error) {
      // The kind the poller stored, not the sentence: a failure is told apart by its type.
      if (row.last_error_kind === "degraded")
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "degraded",
          detail: row.last_error,
        };
      if (restriction)
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: restriction,
        };
      if (/bot protection|captcha|challenge/i.test(row.last_error))
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: "upstream bot protection — waiting for a readable status response",
        };
      if (/HTTP 429$/.test(row.last_error))
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: row.retry_at ? `rate limited — waiting until ${row.retry_at}` : "rate limited — backing off",
        };
      return {
        ...sourceBase,
        ...observationBase,
        group,
        state: "failing",
        detail: row.last_error,
      };
    }
    const since = row.last_success ? now - Date.parse(row.last_success) : Number.POSITIVE_INFINITY;
    if (since > source.intervalSeconds * 3000)
      return {
        ...sourceBase,
        ...observationBase,
        group,
        state: "stale",
        detail: "no fresh observation",
      };
    return { ...sourceBase, ...observationBase, group, state: "ok", detail: "" };
  });
}
