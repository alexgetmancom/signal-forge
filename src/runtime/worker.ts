import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { writeState } from "../storage/appState.js";
import { measure } from "./metrics.js";

export type WorkerHandle = {
  stop: () => Promise<void>;
};

const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long a cycle may run before it is called stalled, when the caller names no bound.
 *
 * A worker that hangs is the one failure the heartbeat cannot see: the heartbeat is written by the
 * timer beside the task, not by the task, so a cycle blocked forever on a socket that will never
 * answer keeps writing `running` every minute and `issues` keeps reporting it healthy. Only a
 * deadline can tell "working" from "hung", because from outside they look the same.
 */
const stallAfter = (intervalMs: number) => Math.max(intervalMs * 5, 600_000);

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
    writeState(db, `worker:${name}`, value);
  } catch (error) {
    log("warn", "Worker state could not be stored", { worker: name, error });
  }
}

export function startIntervalWorker(
  db: Database,
  name: string,
  intervalMs: number,
  task: (signal: AbortSignal) => void | Promise<void>,
  options: { stallAfterMs?: number } = {},
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
    const deadline = options.stallAfterMs ?? stallAfter(intervalMs);
    const abort = new AbortController();
    let stalled = false;
    const stallTimer = setTimeout(() => {
      stalled = true;
      // The heartbeat stops here on purpose. A stalled cycle that keeps saying `running` is the
      // bug; once the deadline passes, the worker goes quiet and `worker_stale` fires on its own
      // even if the task never returns to let the `failed` state below be written.
      clearInterval(heartbeatTimer);
      abort.abort(new Error(`Worker ${name} exceeded ${deadline} ms`));
      storeState(db, name, {
        state: "failed",
        lastStartedAt,
        lastFinishedAt: null,
        durationMs: Date.now() - started,
        lastError: `Cycle still running after ${Math.round(deadline / 1000)}s`,
        lastHeartbeatAt: new Date().toISOString(),
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      });
      log("error", "Worker cycle is stalled", { worker: name, afterMs: deadline });
    }, deadline);
    try {
      await measure(db, `worker:${name}`, () => task(abort.signal));
      if (stalled) {
        // It finished, late. The next cycle is scheduled as usual by the `finally` below, but the
        // stall is not overwritten with `idle`: that a cycle took longer than its deadline is the
        // thing worth keeping, and the next successful cycle clears it.
        log("warn", "Worker cycle finished after it was called stalled", { worker: name });
        return;
      }
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
      clearTimeout(stallTimer);
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
