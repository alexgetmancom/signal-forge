import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { log } from "../logger.js";
import { readState, writeState } from "../storage/appState.js";

export type RuntimeState = {
  bootId: string;
  bootedAt: string;
  stoppedAt: string | null;
  uncleanRestarts: string[];
};

const RUNTIME_KEY = "runtime";
const RESTART_WINDOW_MS = 30 * 60 * 1000;

export function readRuntime(db: Database): RuntimeState | null {
  const stored = readState(db, RUNTIME_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as RuntimeState;
  } catch {
    return null;
  }
}

function writeRuntime(db: Database, state: RuntimeState): void {
  const value = JSON.stringify(state);
  writeState(db, RUNTIME_KEY, value);
}

export function recordRuntimeStart(
  db: Database,
  now = Date.now(),
  bootId: string = crypto.randomUUID(),
): { unclean: boolean; restarts: number } {
  const previous = readRuntime(db);
  const bootedAt = new Date(now).toISOString();
  const unclean = Boolean(previous && !previous.stoppedAt);
  const uncleanRestarts = [
    ...(previous?.uncleanRestarts ?? []).filter((at) => Date.parse(at) >= now - RESTART_WINDOW_MS),
    ...(unclean ? [bootedAt] : []),
  ].slice(-20);
  writeRuntime(db, { bootId, bootedAt, stoppedAt: null, uncleanRestarts });
  if (uncleanRestarts.length >= 3)
    log("error", "Service is restarting repeatedly", { uncleanRestarts: uncleanRestarts.length, windowMinutes: 30 });
  else if (unclean)
    log("warn", "Service restarted without a clean shutdown", { uncleanRestarts: uncleanRestarts.length });
  return { unclean, restarts: uncleanRestarts.length };
}

export function recordRuntimeStop(db: Database, now = Date.now()): void {
  const state = readRuntime(db);
  if (state) writeRuntime(db, { ...state, stoppedAt: new Date(now).toISOString() });
}

function cgroupNumber(name: string): number | null {
  try {
    const raw = readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
    if (raw === "max") return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

const megabytes = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10;

export function logMemoryUsage(): void {
  const memory = process.memoryUsage();
  const limit = cgroupNumber("memory.max");
  const details = {
    rssMb: megabytes(memory.rss),
    heapUsedMb: megabytes(memory.heapUsed),
    heapTotalMb: megabytes(memory.heapTotal),
    externalMb: megabytes(memory.external),
    cgroupCurrentMb: megabytes(cgroupNumber("memory.current")),
    cgroupPeakMb: megabytes(cgroupNumber("memory.peak")),
    cgroupLimitMb: megabytes(limit),
  };
  const pressure = limit !== null && memory.rss >= limit * 0.85;
  log(pressure ? "warn" : "info", pressure ? "Process memory pressure" : "Process memory usage", details);
}

const MEMORY_SAMPLE_RETENTION_DAYS = 90;
const PRESSURE_SHARE = 0.85;

/** The container's cumulative OOM kill count from cgroup v2 memory.events, or null outside one. */
function oomKills(): number | null {
  try {
    const match = /^oom_kill (\d+)$/m.exec(readFileSync("/sys/fs/cgroup/memory.events", "utf8"));
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Stores one memory sample and drops those past retention. A rise in the kill counter since the
 * last stored sample is an OOM kill nobody could log when it happened; this is where it is said.
 */
export function sampleMemory(db: Database, now = Date.now()): void {
  const memory = process.memoryUsage();
  const kills = oomKills();
  const previous = db
    .query<{ oom_kills: number | null }, []>("SELECT oom_kills FROM memory_samples ORDER BY sampled_at DESC LIMIT 1")
    .get();
  if (kills !== null && previous?.oom_kills != null && kills > previous.oom_kills)
    log("error", "Container killed for memory since the last sample", { kills: kills - previous.oom_kills });
  db.query(
    `INSERT OR REPLACE INTO memory_samples(sampled_at,boot_id,rss_mb,heap_used_mb,cgroup_current_mb,cgroup_peak_mb,cgroup_limit_mb,oom_kills)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    new Date(now).toISOString(),
    readRuntime(db)?.bootId ?? null,
    megabytes(memory.rss) ?? 0,
    megabytes(memory.heapUsed) ?? 0,
    megabytes(cgroupNumber("memory.current")),
    megabytes(cgroupNumber("memory.peak")),
    megabytes(cgroupNumber("memory.max")),
    kills,
  );
  db.query("DELETE FROM memory_samples WHERE sampled_at < ?").run(
    new Date(now - MEMORY_SAMPLE_RETENTION_DAYS * 86_400_000).toISOString(),
  );
}

type MemoryDay = {
  day: string;
  samples: number;
  averageRssMb: number;
  maxRssMb: number;
  maxContainerMb: number | null;
  limitMb: number | null;
  samplesAbovePressure: number;
  oomKills: number;
  boots: number;
};

export type MemoryReport = {
  since: string;
  until: string;
  days: MemoryDay[];
  peak: { at: string; rssMb: number; containerMb: number | null } | null;
  oomKills: number;
};

/** Memory by day over a period: typical and worst use, time spent near the limit, and OOM kills. */
export function memoryReport(db: Database, days = 7, now = Date.now()): MemoryReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Memory report days must be between 1 and 90");
  const until = new Date(now).toISOString();
  const since = new Date(now - days * 86_400_000).toISOString();
  const samples = db
    .query<
      {
        sampled_at: string;
        boot_id: string | null;
        rss_mb: number;
        cgroup_current_mb: number | null;
        cgroup_limit_mb: number | null;
        oom_kills: number | null;
      },
      [string, string]
    >(
      "SELECT sampled_at,boot_id,rss_mb,cgroup_current_mb,cgroup_limit_mb,oom_kills FROM memory_samples WHERE sampled_at>=? AND sampled_at<=? ORDER BY sampled_at",
    )
    .all(since, until);
  const byDay = new Map<string, typeof samples>();
  for (const sample of samples) {
    const day = sample.sampled_at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), sample]);
  }
  let lastKills: number | null = null;
  let totalKills = 0;
  const report: MemoryDay[] = [...byDay].map(([day, rows]) => {
    let kills = 0;
    for (const row of rows) {
      if (row.oom_kills !== null && lastKills !== null && row.oom_kills > lastKills) kills += row.oom_kills - lastKills;
      if (row.oom_kills !== null) lastKills = row.oom_kills;
    }
    totalKills += kills;
    const containers = rows.map((row) => row.cgroup_current_mb).filter((value): value is number => value !== null);
    const limit = rows.at(-1)?.cgroup_limit_mb ?? null;
    return {
      day,
      samples: rows.length,
      averageRssMb: Math.round((rows.reduce((sum, row) => sum + row.rss_mb, 0) / rows.length) * 10) / 10,
      maxRssMb: Math.max(...rows.map((row) => row.rss_mb)),
      maxContainerMb: containers.length ? Math.max(...containers) : null,
      limitMb: limit,
      samplesAbovePressure: rows.filter(
        (row) =>
          row.cgroup_limit_mb !== null && (row.cgroup_current_mb ?? row.rss_mb) >= row.cgroup_limit_mb * PRESSURE_SHARE,
      ).length,
      oomKills: kills,
      boots: new Set(rows.map((row) => row.boot_id).filter(Boolean)).size,
    };
  });
  const worst = samples.reduce<(typeof samples)[number] | null>(
    (best, row) => (!best || row.rss_mb > best.rss_mb ? row : best),
    null,
  );
  return {
    since,
    until,
    days: report,
    peak: worst ? { at: worst.sampled_at, rssMb: worst.rss_mb, containerMb: worst.cgroup_current_mb } : null,
    oomKills: totalKills,
  };
}
