import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { readState, writeState } from "../storage/appState.js";
import { measure } from "./metricRecording.js";

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
  /**
   * How many cycles in a row have ended badly, zero once one succeeds.
   *
   * A cycle that failed once and a worker that cannot run are the same row here -- `state: failed`
   * with a message -- and `issues` reported both as an error. On 2026-09-27 a closed socket on one
   * Discord read put `worker:promotion` beside a leaderboard that had been structurally dead for
   * three days, at the same severity, and a list that cannot tell a blink from a break teaches its
   * reader to skip it. The count is what tells them apart, and it is counted here because a cycle is
   * the only unit that means anything: `issues` is read every few minutes and a worker that runs
   * hourly would otherwise report one failure as twelve.
   *
   * Carried across a restart by reading the stored state, so a crash loop does not reset its own
   * count to one each time.
   */
  consecutiveFailures: number;
};

/** The failure count of the last process, so that a restart continues a run rather than starting one. */
function storedConsecutiveFailures(db: Database, name: string): number {
  const stored = readState(db, `worker:${name}`);
  if (!stored) return 0;
  try {
    const value: unknown = JSON.parse(stored);
    const count = (value as { consecutiveFailures?: unknown }).consecutiveFailures;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function storeState(db: Database, name: string, state: WorkerState): void {
  try {
    const value = JSON.stringify(state);
    writeState(db, `worker:${name}`, value);
  } catch (error) {
    log("warn", "Worker state could not be stored", { worker: name, error });
  }
}

/**
 * The row that says a cycle is alive: written when it starts and again on every heartbeat.
 *
 * The two writes are the same row with a different instant on it, and the only thing they carry
 * forward is the failure count of the cycles before this one, which must survive a cycle that is
 * merely running.
 */
function storeRunning(
  db: Database,
  name: string,
  lastStartedAt: string,
  heartbeatAt: string,
  consecutiveFailures: number,
): void {
  storeState(db, name, {
    state: "running",
    lastStartedAt,
    lastFinishedAt: null,
    durationMs: null,
    lastError: null,
    lastHeartbeatAt: heartbeatAt,
    heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
    consecutiveFailures,
  });
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
  let consecutiveFailures = storedConsecutiveFailures(db, name);

  const run = async (): Promise<void> => {
    if (stopped) return;
    const started = Date.now();
    lastStartedAt = new Date(started).toISOString();
    // A cycle counts once however many ways it ends badly: a stall aborts the task, and the abort
    // then arrives in the catch below as an error from the same cycle.
    let counted = false;
    const countFailure = (): number => {
      if (!counted) {
        counted = true;
        consecutiveFailures += 1;
      }
      return consecutiveFailures;
    };
    storeRunning(db, name, lastStartedAt, lastStartedAt, consecutiveFailures);
    const heartbeatTimer = setInterval(() => {
      if (stopped) return;
      storeRunning(db, name, lastStartedAt, new Date().toISOString(), consecutiveFailures);
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
        consecutiveFailures: countFailure(),
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
      consecutiveFailures = 0;
      storeState(db, name, {
        state: "idle",
        lastStartedAt,
        lastFinishedAt: finishedAt,
        durationMs: Date.now() - started,
        lastError: null,
        lastHeartbeatAt: finishedAt,
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
        consecutiveFailures,
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
        consecutiveFailures: countFailure(),
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
          consecutiveFailures,
        });
        log("info", "Worker stopped", { worker: name });
      });
      return stopPromise;
    },
  };
}
