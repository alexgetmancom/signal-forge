import { describe, expect, test } from "bun:test";
import { sleep } from "../src/runtime/sleep.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { startIntervalWorker } from "../src/runtime/worker.js";

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
    let runs = 0;
    const worker = startIntervalWorker("test", 60_000, () => {
      runs += 1;
    });
    await worker.stop();
    expect(runs).toBe(1);
  });

  test("awaits the in-flight cycle before reporting stopped", async () => {
    let finished = false;
    const worker = startIntervalWorker("test", 60_000, async () => {
      await Bun.sleep(20);
      finished = true;
    });
    await worker.stop();
    expect(finished).toBe(true);
  });

  test("keeps running after a failing cycle", async () => {
    let runs = 0;
    const worker = startIntervalWorker("test", 5, () => {
      runs += 1;
      throw new Error("boom");
    });
    await Bun.sleep(30);
    await worker.stop();
    // A thrown cycle must not kill the schedule: the next one still fires.
    expect(runs).toBeGreaterThan(1);
  });

  test("rejects a non-positive interval", () => {
    expect(() => startIntervalWorker("test", 0, () => {})).toThrow();
  });
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
