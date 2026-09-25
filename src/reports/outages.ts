import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * One host falling over, reported once instead of once per source that was pointed at it.
 *
 * Sources are read one at a time and their failures are recorded one at a time, so a host that
 * stops answering produces a row per source and every report counts them separately. Measured on
 * production 2026-09-25: the five `artificial-analysis` sources logged 53 `ECONNRESET` in seven
 * days, ten per cent each -- every one of them just over the bar `flaky` uses, none of them
 * obviously related, and on 2026-09-20 at 20:34 three of them failed inside the same minute. That
 * is one outage of one host seen five times, and reading it as five intermittent collectors sends
 * somebody to five collectors.
 *
 * The grouping is the pacing group, which is already a host name -- it exists because those sources
 * share a rate limit, which is the same fact as sharing a host. Sources without one fall back to
 * their registry group, which is coarser and can put two hosts together; `concurrentMinutes` is what
 * distinguishes a real shared outage from a coincidence, because two sources failing in the same
 * minute is not something independent failures do often.
 */
export type Outage = {
  /** The pacing group, or the registry group for sources that declare no pace. */
  group: string;
  /** Whether the group is a shared rate limit -- a host -- or only a display grouping. */
  paced: boolean;
  sources: number;
  failures: number;
  kinds: Record<string, number>;
  /** Minutes in which more than one source of this group failed: the signature of one cause. */
  concurrentMinutes: number;
  /** Failures that landed in one of those minutes. The rest may well be unrelated. */
  concurrentFailures: number;
  firstAt: string;
  lastAt: string;
  /**
   * Every source of the group that failed, and how many of its failures landed in a minute shared
   * with a sibling. `concurrent: 0` is a source that failed alone: it is in the group because the
   * group is a host, not because it took part in the outage, and a reader of this list who treats
   * membership as participation reports a host outage against a collector that never joined one.
   */
  members: { id: string; failures: number; concurrent: number }[];
};

/** One source failing is a source. Two of the same group failing together is a host. */
const MIN_SOURCES = 2;

export function outages(db: Database, config: AppConfig, days = 7, now = Date.now()): Outage[] {
  const from = new Date(now - days * 24 * 3_600_000).toISOString();
  const registry = buildSourceRegistry(db, config).filter((definition) => definition.enabled);
  const groupOf = new Map(
    registry.map((definition) => [definition.id, definition.pace?.group ?? definition.group] as const),
  );
  const pacedGroups = new Set(
    registry.filter((definition) => definition.pace).map((definition) => definition.pace?.group as string),
  );
  const rows = db
    .query<{ source: string; minute: string; kind: string; failures: number }, [string]>(
      `SELECT source,
              substr(collected_at, 1, 16) AS minute,
              COALESCE(failure_kind, CASE WHEN error LIKE 'Collection degraded:%' THEN 'degraded' ELSE 'before_kinds_were_recorded' END)
                AS kind,
              COUNT(*) AS failures
       FROM source_collection_metrics
       WHERE collected_at >= ? AND success = 0
       GROUP BY source, minute, kind`,
    )
    .all(from);

  type Accumulator = {
    members: Map<string, number>;
    kinds: Map<string, number>;
    minutes: Map<string, Map<string, number>>;
    firstAt: string;
    lastAt: string;
  };
  const groups = new Map<string, Accumulator>();
  for (const row of rows) {
    const group = groupOf.get(row.source);
    // A source that is no longer in the registry is a retired source, not a broken one.
    if (group === undefined) continue;
    const entry = groups.get(group) ?? {
      members: new Map(),
      kinds: new Map(),
      minutes: new Map(),
      firstAt: row.minute,
      lastAt: row.minute,
    };
    entry.members.set(row.source, (entry.members.get(row.source) ?? 0) + row.failures);
    entry.kinds.set(row.kind, (entry.kinds.get(row.kind) ?? 0) + row.failures);
    const minute = entry.minutes.get(row.minute) ?? new Map<string, number>();
    minute.set(row.source, (minute.get(row.source) ?? 0) + row.failures);
    entry.minutes.set(row.minute, minute);
    if (row.minute < entry.firstAt) entry.firstAt = row.minute;
    if (row.minute > entry.lastAt) entry.lastAt = row.minute;
    groups.set(group, entry);
  }

  return [...groups.entries()]
    .map(([group, entry]) => {
      const shared = [...entry.minutes.values()].filter((minute) => minute.size > 1);
      const together = new Map<string, number>();
      for (const minute of shared)
        for (const [source, failures] of minute) together.set(source, (together.get(source) ?? 0) + failures);
      return {
        group,
        paced: pacedGroups.has(group),
        sources: entry.members.size,
        failures: [...entry.members.values()].reduce((total, count) => total + count, 0),
        kinds: Object.fromEntries([...entry.kinds.entries()].sort((left, right) => right[1] - left[1])),
        concurrentMinutes: shared.length,
        concurrentFailures: shared.reduce(
          (total, minute) => total + [...minute.values()].reduce((sum, count) => sum + count, 0),
          0,
        ),
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
        members: [...entry.members.entries()]
          .map(([id, failures]) => ({ id, failures, concurrent: together.get(id) ?? 0 }))
          .sort((left, right) => right.failures - left.failures),
      };
    })
    .filter((entry) => entry.sources >= MIN_SOURCES)
    .sort(
      (left, right) =>
        right.concurrentFailures - left.concurrentFailures ||
        right.failures - left.failures ||
        left.group.localeCompare(right.group),
    );
}
