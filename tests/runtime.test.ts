import { describe, expect, test } from "bun:test";
import { recordRuntimeStart, recordRuntimeStop } from "../src/runtime/observability.js";
import { sleep } from "../src/runtime/sleep.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { startIntervalWorker } from "../src/runtime/worker.js";
import { openDatabase } from "../src/storage/database.js";

describe("RuntimeSupervisor", () => {
  test("stops registered resources in reverse order", async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      stop: () => {
        events.push("first");
      },
    });
    supervisor.register({
      stop: async () => {
        events.push("second");
      },
    });
    await supervisor.stop();
    expect(events).toEqual(["second", "first"]);
  });

  test("stops each resource once, however often stop is called", async () => {
    let stops = 0;
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      stop: () => {
        stops += 1;
      },
    });
    await Promise.all([supervisor.stop(), supervisor.stop()]);
    await supervisor.stop();
    expect(stops).toBe(1);
  });

  test("refuses registrations once shutdown has started", async () => {
    const supervisor = new RuntimeSupervisor();
    await supervisor.stop();
    expect(() => supervisor.register({ stop: () => {} })).toThrow();
  });

  test("unregistering keeps a resource out of the shutdown", async () => {
    let stopped = false;
    const supervisor = new RuntimeSupervisor();
    const unregister = supervisor.register({
      stop: () => {
        stopped = true;
      },
    });
    unregister();
    await supervisor.stop();
    expect(stopped).toBe(false);
  });
});

describe("startIntervalWorker", () => {
  test("runs the first cycle immediately", async () => {
    const db = openDatabase(":memory:");
    let runs = 0;
    const worker = startIntervalWorker(db, "test", 60_000, () => {
      runs += 1;
    });
    await worker.stop();
    expect(runs).toBe(1);
    const state = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get("worker:test");
    expect(JSON.parse(state?.value ?? "{}").state).toBe("stopped");
    db.close();
  });

  test("awaits the in-flight cycle before reporting stopped", async () => {
    const db = openDatabase(":memory:");
    let finished = false;
    const worker = startIntervalWorker(db, "test", 60_000, async () => {
      await Bun.sleep(20);
      finished = true;
    });
    await worker.stop();
    expect(finished).toBe(true);
    db.close();
  });

  test("keeps running after a failing cycle", async () => {
    const db = openDatabase(":memory:");
    let runs = 0;
    const worker = startIntervalWorker(db, "test", 5, () => {
      runs += 1;
      throw new Error("boom");
    });
    await Bun.sleep(30);
    await worker.stop();
    // A thrown cycle must not kill the schedule: the next one still fires.
    expect(runs).toBeGreaterThan(1);
    db.close();
  });

  test("rejects a non-positive interval", () => {
    const db = openDatabase(":memory:");
    expect(() => startIntervalWorker(db, "test", 0, () => {})).toThrow();
    db.close();
  });
});

test("runtime state distinguishes clean stops from crash-loop restarts", () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  expect(recordRuntimeStart(db, now, "first")).toEqual({ unclean: false, restarts: 0 });
  expect(recordRuntimeStart(db, now + 1000, "second")).toEqual({ unclean: true, restarts: 1 });
  recordRuntimeStop(db, now + 2000);
  expect(recordRuntimeStart(db, now + 3000, "third")).toEqual({ unclean: false, restarts: 1 });
  db.close();
});

describe("sleep", () => {
  test("resolves after the delay", async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("returns early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await sleep(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns immediately for an already aborted signal", async () => {
    const started = Date.now();
    await sleep(5_000, AbortSignal.abort());
    expect(Date.now() - started).toBeLessThan(100);
  });
});
