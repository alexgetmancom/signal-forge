import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { measure } from "./metrics.js";

export type WorkerHandle = {
  stop: () => Promise<void>;
};

const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;

type WorkerState = {
  state: "running" | "idle" | "failed" | "stopped";
  lastStartedAt: string;
  lastFinishedAt: string | null;
  durationMs: number | null;
  lastError: string | null;
  lastHeartbeatAt: string;
  heartbeatIntervalMs: number;
};

function storeState(db: Database, name: string, state: WorkerState): void {
  try {
    const value = JSON.stringify(state);
    db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      `worker:${name}`,
      value,
    );
  } catch (error) {
    log("warn", "Worker state could not be stored", { worker: name, error });
  }
}

export function startIntervalWorker(
  db: Database,
  name: string,
  intervalMs: number,
  task: () => void | Promise<void>,
): WorkerHandle {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Worker interval must be a positive integer");
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  let lastStartedAt = new Date().toISOString();

  const run = async (): Promise<void> => {
    if (stopped) return;
    const started = Date.now();
    lastStartedAt = new Date(started).toISOString();
    storeState(db, name, {
      state: "running",
      lastStartedAt,
      lastFinishedAt: null,
      durationMs: null,
      lastError: null,
      lastHeartbeatAt: lastStartedAt,
      heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
    });
    const heartbeatTimer = setInterval(() => {
      if (stopped) return;
      const heartbeat = new Date().toISOString();
      storeState(db, name, {
        state: "running",
        lastStartedAt,
        lastFinishedAt: null,
        durationMs: null,
        lastError: null,
        lastHeartbeatAt: heartbeat,
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    try {
      await measure(db, `worker:${name}`, task);
      const finishedAt = new Date().toISOString();
      storeState(db, name, {
        state: "idle",
        lastStartedAt,
        lastFinishedAt: finishedAt,
        durationMs: Date.now() - started,
        lastError: null,
        lastHeartbeatAt: finishedAt,
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      });
      log("debug", "Worker cycle completed", { worker: name });
    } catch (error) {
      storeState(db, name, {
        state: "failed",
        lastStartedAt,
        lastFinishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        lastError: error instanceof Error ? error.message : String(error),
        lastHeartbeatAt: new Date().toISOString(),
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      });
      log("error", "Worker cycle failed", { worker: name, error });
    } finally {
      clearInterval(heartbeatTimer);
      if (!stopped) timer = setTimeout(startCycle, intervalMs);
    }
  };

  const startCycle = (): void => {
    currentRun = run();
    void currentRun;
  };

  startCycle();

  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearTimeout(timer);
      stopPromise = currentRun.then(() => {
        storeState(db, name, {
          state: "stopped",
          lastStartedAt,
          lastFinishedAt: new Date().toISOString(),
          durationMs: null,
          lastError: null,
          lastHeartbeatAt: new Date().toISOString(),
          heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
        });
        log("info", "Worker stopped", { worker: name });
      });
      return stopPromise;
    },
  };
}
