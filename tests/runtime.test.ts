import { describe, expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { pollSources } from "../src/poller.js";
import { recordRuntimeStart, recordRuntimeStop } from "../src/runtime/observability.js";
import { sleep } from "../src/runtime/sleep.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { startIntervalWorker } from "../src/runtime/worker.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

async function pollWithMode(mode: "active" | "shadow"): Promise<ReturnType<typeof openDatabase>> {
  const db = openDatabase(":memory:");
  const base = loadConfig({ CONFIG_PATH: configPath });
  const destination: Destination = { id: "dc", platform: "discord", channelId: "123", streams: ["openrouter"] };
  const allIds = (await import("../src/sources/registry.js")).buildSourceRegistry(db, base).map((source) => source.id);
  const config = {
    ...base,
    sourceEnabled: Object.fromEntries(allIds.map((id) => [id, id === "openrouter"])),
    sourceMode: { openrouter: mode },
    destinations: [destination],
  };
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const records =
      calls === 1
        ? [
            {
              id: "openai/gpt-6",
              name: "GPT-6",
              created: 1,
              context_length: 128000,
              pricing: {},
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            },
          ]
        : [
            {
              id: "openai/gpt-6",
              name: "GPT-6",
              created: 1,
              context_length: 128000,
              pricing: {},
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            },
            {
              id: "openai/gpt-7",
              name: "GPT-7",
              created: 1,
              context_length: 256000,
              pricing: {},
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            },
          ];
    return Response.json({ data: records });
  }) as unknown as typeof fetch;
  try {
    await pollSources(db, config, true);
    await pollSources(db, config, true);
  } finally {
    globalThis.fetch = original;
  }
  expect(db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
  expect(db.query("SELECT COUNT(*) AS count FROM source_collection_metrics WHERE source='openrouter'").get()).toEqual({
    count: 2,
  });
  expect(db.query("SELECT COUNT(*) AS count FROM batches").get()).toEqual({ count: mode === "active" ? 1 : 0 });
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: mode === "active" ? 1 : 0 });
  return db;
}

test("active polling preserves normal delivery fanout", async () => {
  const db = await pollWithMode("active");
  db.close();
});

test("shadow polling keeps events and metrics but creates no delivery work", async () => {
  const db = await pollWithMode("shadow");
  expect(db.query("SELECT kind FROM events").all()).toEqual([{ kind: "new" }]);
  db.close();
});

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
    expect(JSON.parse(state?.value ?? "{}")).toMatchObject({
      state: "stopped",
      heartbeatIntervalMs: 60_000,
    });
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
