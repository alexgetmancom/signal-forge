import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { callOperation, operations } from "../src/operations.js";
import { sourceProfile } from "../src/reports/sourceProfile.js";
import { buildSourceRegistry, recordSourceIdentities } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";
import { aBatch, aDelivery, anAttempt, anEvent, aSource } from "./fixtures/build.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = () => loadConfig({ CONFIG_PATH: configPath, MCP_TOKEN: "x".repeat(32) });
const now = new Date("2026-10-02T12:00:00.000Z");

function seed() {
  const db = openDatabase(":memory:");
  aSource(db, "arena", { lastSuccess: "2026-10-02T11:00:00.000Z", checkedAt: "2026-10-02T11:00:00.000Z" });
  return db;
}

test("a registered source answers with what it declares, how it is doing and what it produced", () => {
  const db = seed();
  const cfg = config();
  const declared = buildSourceRegistry(db, cfg).find((definition) => definition.id === "arena");
  expect(declared).toBeDefined();

  const kept = storeSnapshot(db, "arena", "2026-10-02T11:00:00.000Z", JSON.stringify({ models: [1, 2, 3] }));
  const sent = anEvent(db, {
    source: "arena",
    kind: "new",
    detectedAt: "2026-10-01T00:00:00.000Z",
    snapshotId: kept.id,
  });
  anEvent(db, { source: "arena", kind: "changed", detectedAt: "2026-10-02T00:00:00.000Z", snapshotId: kept.id });
  anEvent(db, { source: "arena", kind: "new", detectedAt: "2026-06-01T00:00:00.000Z", snapshotId: kept.id });
  db.query("INSERT INTO records(source,id,body,stream,observed_at,missing_count) VALUES(?,?,?,?,?,?)").run(
    "arena",
    "a",
    "{}",
    "arena",
    "2026-10-02T11:00:00.000Z",
    0,
  );
  db.query("INSERT INTO records(source,id,body,stream,observed_at,missing_count) VALUES(?,?,?,?,?,?)").run(
    "arena",
    "b",
    "{}",
    "arena",
    "2026-10-01T11:00:00.000Z",
    2,
  );
  anAttempt(db, "arena", null, "2026-10-02T10:00:00.000Z");
  anAttempt(db, "arena", { error: "Source returned HTTP 500", kind: "http" }, "2026-10-02T11:00:00.000Z");
  const batch = aBatch(db, { source: "arena" });
  const delivery = aDelivery(db, { batchId: batch, status: "sent" });
  db.query("INSERT INTO delivery_events(delivery_id,event_id) VALUES(?,?)").run(delivery, sent);

  const profile = sourceProfile(db, cfg, "arena", 30, now);
  expect(profile).toMatchObject({
    source: "arena",
    registered: true,
    retiredAt: null,
    definition: { stream: declared?.stream, authority: declared?.authority, enabled: true, waitingOn: [] },
    state: { lastSuccess: "2026-10-02T11:00:00.000Z", failures: 0 },
    records: { count: 2, missing: 1, newestObservedAt: "2026-10-02T11:00:00.000Z" },
    // The June event is in the total and outside the thirty-day window.
    events: { total: 3, lastDetectedAt: "2026-10-02T00:00:00.000Z", inWindow: { new: 1, changed: 1, removed: 0 } },
    collections: { attempts: 2, failures: 1, failureKinds: { http: 1 } },
    latestSnapshot: { id: kept.id, bodyKept: true },
    sentInWindow: 1,
    windowDays: 30,
  });
  expect(profile?.collections.latest.map((row) => row.ok)).toEqual([false, true]);
  // The collector is code, not an answer.
  expect(JSON.stringify(profile)).not.toContain("collector");
  db.close();
});

test("a source waiting for a credential says which one", () => {
  const db = openDatabase(":memory:");
  const profile = sourceProfile(db, config(), "mimo", 7, now);
  expect(profile?.registered).toBe(true);
  expect(profile?.definition?.waitingOn).toEqual(["MIMO_API_KEY"]);
  expect(profile?.state).toBeNull();
  expect(profile?.events.total).toBe(0);
  db.close();
});

test("a retired source still answers, and says it is not registered", () => {
  const db = seed();
  aSource(db, "designarena:gone", { lastSuccess: "2026-09-09T00:00:00.000Z" });
  anEvent(db, { source: "designarena:gone", detectedAt: "2026-08-20T00:00:00.000Z" });
  const cfg = config();
  recordSourceIdentities(db, buildSourceRegistry(db, cfg), "2026-10-02T09:00:00.000Z");

  const profile = sourceProfile(db, cfg, "designarena:gone", 30, now);
  expect(profile).toMatchObject({
    registered: false,
    retiredAt: "2026-10-02T09:00:00.000Z",
    definition: null,
    state: { lastSuccess: "2026-09-09T00:00:00.000Z" },
    events: { total: 1, inWindow: { new: 0, changed: 0, removed: 0 } },
  });
  db.close();
});

test("an unknown name is refused with the names that could have been meant", () => {
  const db = seed();
  const cfg = config();
  expect(sourceProfile(db, cfg, "arenaa", 30, now)).toBeNull();
  const defs = operations(db, cfg);
  expect(() => callOperation(defs, "source", { source: "arenaa" })).toThrow(/ever collected\. Closest here: .*arena/);
  expect(callOperation(defs, "source", { source: "arena" })).toMatchObject({ source: "arena", windowDays: 30 });
  db.close();
});

test("over HTTP a source id with slashes and colons is the rest of the path", async () => {
  const db = seed();
  aSource(db, "npm:@openai/codex", { lastSuccess: "2026-10-02T11:00:00.000Z" });
  const cfg = config();
  const app = createHttpApp(cfg, db);
  const auth = { Authorization: `Bearer ${cfg.MCP_TOKEN}` };

  expect((await app.request("/api/sources/arena", { headers: auth })).status).toBe(200);
  const slashed = await app.request("/api/sources/npm:@openai/codex?days=7", { headers: auth });
  expect(slashed.status).toBe(200);
  expect(await slashed.json()).toMatchObject({ source: "npm:@openai/codex", registered: true, windowDays: 7 });
  const missing = await app.request("/api/sources/nothing-like-it", { headers: auth });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toContain("ever collected");
  expect((await app.request("/api/sources/arena")).status).toBe(401);
  db.close();
});
