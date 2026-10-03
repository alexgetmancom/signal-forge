import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { storageOperations } from "../src/operations/storage.js";
import { callOperation, operations } from "../src/operations.js";
import { storageReport } from "../src/reports/storage.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { storeSnapshot } from "../src/storage/snapshots.js";
import { anEvent } from "./fixtures/build.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = () => loadConfig({ CONFIG_PATH: configPath, MCP_TOKEN: "x".repeat(32) });
const now = new Date("2026-10-02T12:00:00.000Z");
const at = (day: string) => `${day}T08:00:00.000Z`;

/** Text that does not compress, so two payloads of the same length weigh differently stored. */
const noise = (length: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString("hex");

test("compaction releases old payload pages while retaining the latest payload and event evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-forge-compact-"));
  const db = openDatabase(join(directory, "app.db"));
  try {
    const old = storeSnapshot(db, "openrouter", new Date(Date.now() - 3 * 86_400_000).toISOString(), noise(1_200_000));
    storeSnapshot(db, "openrouter", new Date().toISOString(), '{"latest":true}');
    const event = anEvent(db, { source: "openrouter", snapshotId: old.id, afterJson: '{"pricing":{"prompt":"1"}}' });
    const evidence = db.query("SELECT * FROM events WHERE id=?").get(event);

    const result = callOperation(storageOperations(db, config()), "compact_storage") as {
      beforeBytes: number;
      afterBytes: number;
      releasedBytes: number;
      expiredBodies: number;
    };

    expect(result.expiredBodies).toBe(1);
    expect(result.releasedBytes).toBeGreaterThan(1_000_000);
    expect(result.releasedBytes).toBe(result.beforeBytes - result.afterBytes);
    expect(db.query("SELECT * FROM events WHERE id=?").get(event)).toEqual(evidence);
    expect(db.query("SELECT COUNT(*) n FROM snapshots").get()).toEqual({ n: 2 });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seeded() {
  const db = openDatabase(":memory:");
  const entered = (text: string) => JSON.stringify({ text });
  // Two complete days and part of today, and one event that is older than the window.
  anEvent(db, { source: "arena", detectedAt: at("2026-09-01"), afterJson: entered("o".repeat(10)) });
  anEvent(db, { source: "arena", detectedAt: at("2026-10-01"), afterJson: entered("a".repeat(100)) });
  anEvent(db, { source: "arena", detectedAt: at("2026-10-01"), afterJson: entered("b".repeat(200)), beforeJson: "{}" });
  anEvent(db, { source: "arena", detectedAt: at("2026-10-02"), afterJson: entered("c".repeat(50)) });
  db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?)").run(
    "arena",
    "a",
    "x".repeat(40),
    "arena",
    at("2026-10-02"),
  );
  new HttpCache(db).put("https://example.test/a.js", {
    etag: null,
    lastModified: null,
    freshUntil: 0,
    body: "y".repeat(500),
  });
  return db;
}

test("bodies are counted in bytes, by table, largest first", () => {
  const db = seeded();
  const report = storageReport(db, { days: 14, top: 10, now });
  const sizeOf = (text: string, extra = "") => Buffer.byteLength(JSON.stringify({ text })) + Buffer.byteLength(extra);

  const events = report.bodies.find((body) => body.table === "events");
  expect(events?.rows).toBe(4);
  expect(events?.bytes).toBe(
    sizeOf("o".repeat(10)) + sizeOf("a".repeat(100)) + sizeOf("b".repeat(200), "{}") + sizeOf("c".repeat(50)),
  );
  expect(report.bodies.find((body) => body.table === "records")).toEqual({ table: "records", rows: 1, bytes: 40 });
  expect(report.bodies.find((body) => body.table === "http_cache")).toEqual({
    table: "http_cache",
    rows: 1,
    bytes: Bun.gzipSync(Buffer.from("y".repeat(500))).length,
  });
  expect(report.bodies.map((body) => body.bytes)).toEqual(
    [...report.bodies.map((body) => body.bytes)].sort((a, b) => b - a),
  );
  db.close();
});

test("the file is accounted for, and a remainder is never negative", () => {
  const db = seeded();
  const report = storageReport(db, { days: 14, top: 10, now });
  const held = report.bodies.reduce((sum, body) => sum + body.bytes, 0);
  expect(report.file.bytes).toBeGreaterThan(0);
  expect(report.file.budgetBytes).toBe(5 * 1024 ** 3);
  expect(report.unaccountedBytes).toBe(Math.max(0, report.file.bytes - report.file.freeBytes - held));
  // An in-memory database has no file beside it, so there is no log to weigh.
  expect(report.file.walBytes).toBeNull();
  db.close();
});

test("the log beside a file database is weighed", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "signal-forge-storage-")), "app.db"));
  anEvent(db, { detectedAt: at("2026-10-01") });
  expect(storageReport(db, { days: 14, top: 10, now }).file.walBytes).toBeGreaterThan(0);
  db.close();
});

test("stored payloads are ranked by source, and a released body is a receipt with no bytes", () => {
  const db = openDatabase(":memory:");
  storeSnapshot(db, "models-dev", "2026-10-02T10:00:00.000Z", noise(5000));
  storeSnapshot(db, "models-dev", "2026-10-02T11:00:00.000Z", noise(5001));
  storeSnapshot(db, "arena", "2026-10-02T10:30:00.000Z", "a".repeat(5000));
  const released = storeSnapshot(db, "arena", "2026-10-01T10:30:00.000Z", "b".repeat(300));
  db.query("UPDATE snapshots SET body=NULL,expired_at=? WHERE id=?").run("2026-10-02T11:30:00.000Z", released.id);

  const { snapshots } = storageReport(db, { days: 14, top: 10, now });
  expect(snapshots.rows).toBe(4);
  expect(snapshots.expiredRows).toBe(1);
  expect(snapshots.bySource.map((row) => row.source)).toEqual(["models-dev", "arena"]);
  const [first, second] = snapshots.bySource;
  expect(first).toMatchObject({ source: "models-dev", rows: 2, keptRows: 2, newestAt: "2026-10-02T11:00:00.000Z" });
  expect(first?.bytes).toBeGreaterThan(5000);
  expect(first?.avgBytes).toBe(Math.round((first?.bytes ?? 0) / 2));
  expect(second).toMatchObject({ source: "arena", rows: 2, keptRows: 1 });
  expect(snapshots.topShare).toBe(1);

  // `top` cuts the list, and the share then says how much of the whole the shown sources hold.
  const one = storageReport(db, { days: 14, top: 1, now }).snapshots;
  expect(one.bySource).toHaveLength(1);
  expect(one.topShare).toBeGreaterThan(0.5);
  expect(one.topShare).toBeLessThan(1);
  db.close();
});

test("events are bucketed by day inside the window, and pace is read from complete days only", () => {
  const db = seeded();
  const { events } = storageReport(db, { days: 14, top: 10, now });
  // The event from September is outside fourteen days; the two on the 1st and the one today are in.
  expect(events.days.map((row) => [row.day, row.events])).toEqual([
    ["2026-10-01", 2],
    ["2026-10-02", 1],
  ]);
  // Today is half a day and is left out of the pace: one complete day, two events on it.
  expect(events.pace).toMatchObject({ eventsPerDay: 2, basisDays: 1 });
  expect(events.pace?.bytesPerDay).toBe(events.days[0]?.bytes);

  // A window wide enough to take the September event spreads it over the quiet days between.
  const wide = storageReport(db, { days: 90, top: 10, now }).events;
  // 1 September to 1 October inclusive, the complete days between the first event and today.
  expect(wide.pace?.basisDays).toBe(31);
  expect(wide.pace?.eventsPerDay).toBe(Math.round(3 / 31));
  db.close();
});

test("the window starts at midnight, so the first day is a whole day and not the part after the hour of asking", () => {
  const db = openDatabase(":memory:");
  // 14 days before the 2nd is the 18th. Asked at noon, the old window began at noon on the 18th and
  // dropped the morning event, so the 18th counted as a day with one event in it.
  anEvent(db, { detectedAt: "2026-09-18T08:00:00.000Z", afterJson: "{}" });
  anEvent(db, { detectedAt: "2026-09-18T13:00:00.000Z", afterJson: "{}" });
  anEvent(db, { detectedAt: "2026-09-17T23:59:59.000Z", afterJson: "{}" });
  anEvent(db, { detectedAt: "2026-10-01T09:00:00.000Z", afterJson: "{}" });
  const { events } = storageReport(db, { days: 14, top: 10, now });
  expect(events.days.map((row) => [row.day, row.events])).toEqual([
    ["2026-09-18", 2],
    ["2026-10-01", 1],
  ]);
  // Fourteen complete days, the 18th to the 1st, and three events in them.
  expect(events.pace).toMatchObject({ basisDays: 14, eventsPerDay: Math.round(3 / 14) });
  db.close();
});

test("with nothing complete to average there is no pace, rather than an invented one", () => {
  const db = openDatabase(":memory:");
  expect(storageReport(db, { days: 14, top: 10, now }).events.pace).toBeNull();
  anEvent(db, { detectedAt: at("2026-10-02") });
  expect(storageReport(db, { days: 14, top: 10, now }).events.pace).toBeNull();
  db.close();
});

test("`storage` is an operation on every surface it declares", async () => {
  const db = seeded();
  const cfg = config();
  expect(callOperation(operations(db, cfg), "storage", { days: "7" })).toMatchObject({
    events: { windowDays: 7 },
    file: { walBytes: null },
  });
  const app = createHttpApp(cfg, db);
  const auth = { Authorization: `Bearer ${cfg.MCP_TOKEN}` };
  const answered = await app.request("/api/storage?days=30&top=3", { headers: auth });
  expect(answered.status).toBe(200);
  expect(await answered.json()).toMatchObject({ events: { windowDays: 30 } });
  expect((await app.request("/api/storage")).status).toBe(401);
  db.close();
});
