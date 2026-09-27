import type { Database } from "bun:sqlite";
import { readRuntime } from "./observability.js";

export type TimingsQuery = {
  /** Only sections whose name contains this, so one subsystem can be asked about on its own. */
  name?: string | undefined;
  /** How many of the slowest sections to return. The full list is a wall nobody reads. */
  limit?: number | undefined;
  /** The per-hour series, which is only wanted when the question is "when", not "what". */
  timeline?: boolean | undefined;
  /**
   * Where to start instead of counting back whole days: `boot` for this process's start, an ISO
   * instant, or a span such as `90m`, `6h` or `2d`. The question after a deploy is what the new
   * build costs, and `days` cannot ask it.
   */
  since?: string | undefined;
};

const SPAN = /^(\d+)(m|h|d)$/;
const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The moment `--since` names, as a number. Throws rather than silently measuring the wrong week. */
export function askedFrom(db: Database, value: string, now: number): number {
  if (value === "boot") {
    const bootedAt = readRuntime(db)?.bootedAt;
    if (!bootedAt) throw new Error("This process has not recorded a start time, so `--since boot` has nothing to use");
    return Date.parse(bootedAt);
  }
  const span = SPAN.exec(value);
  if (span) return now - Number(span[1]) * (SPAN_MS[span[2] as string] as number);
  const at = Date.parse(value);
  if (!Number.isFinite(at))
    throw new Error(`Cannot read \`${value}\` as a moment: use boot, an ISO instant, or 90m, 6h, 2d`);
  return at;
}

/**
 * The window a report covers and the name it was narrowed to, as the three parameters every query
 * below takes. `wanted` is empty for "every section", which is a condition SQL can carry rather
 * than a filter this process applies to rows it already built.
 *
 * The queries number their parameters -- `?1` is the window's start wherever it appears -- because
 * each of them names the same value more than once, and a positional list that has to be read
 * against the order the placeholders happen to appear in is a list somebody gets wrong. Named
 * parameters are not the way out: only a handle opened `strict` matches them by bare name, and this
 * report is asked through read-only handles that are not, where a name that matches nothing binds
 * null and answers about an empty window instead of failing.
 */
export type Window = { from: string; to: string; wanted: string };

/** A window as the queries below take it. */
export function bounds(window: Window): [string, string, string] {
  return [window.from, window.to, window.wanted];
}
