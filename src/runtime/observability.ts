import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { log } from "../logger.js";

type RuntimeState = {
  bootId: string;
  bootedAt: string;
  stoppedAt: string | null;
  uncleanRestarts: string[];
};

const RUNTIME_KEY = "runtime";
const RESTART_WINDOW_MS = 30 * 60 * 1000;

function readRuntime(db: Database): RuntimeState | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(RUNTIME_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RuntimeState;
  } catch {
    return null;
  }
}

function writeRuntime(db: Database, state: RuntimeState): void {
  const value = JSON.stringify(state);
  db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    RUNTIME_KEY,
    value,
  );
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
