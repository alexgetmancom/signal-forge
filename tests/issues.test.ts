import { expect, test } from "bun:test";
import { capabilityReport } from "../src/capabilities.js";
import type { Destination } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { listActionableIssues } from "../src/issues.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

test("capabilities distinguish disabled integrations from missing credentials", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  const destination: Destination = { id: "tg", platform: "telegram", chatId: "-100", streams: ["news"] };
  const report = capabilityReport(db, {
    ...config,
    sourceEnabled: { openai: false },
    destinations: [destination],
  });
  expect(report.find((entry) => entry.id === "openai")).toMatchObject({ status: "disabled" });
  expect(capabilityReport(db, { ...config, destinations: [] }).find((entry) => entry.id === "openai")).toMatchObject({
    status: "missing",
  });
  expect(report.find((entry) => entry.id === "telegram")).toMatchObject({ status: "missing", missingCount: 1 });
  expect(JSON.stringify(report)).not.toContain("fake");
  db.close();
});

test("actionable issues use stable identities across source, delivery, worker and restart failures", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query(
    "INSERT INTO sources(id,last_error,checked_at,failures) VALUES('openrouter','HTTP 500','2026-09-08T11:59:00.000Z',1)",
  ).run();
  db.exec(
    "INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'openrouter',0,1);" +
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(7,1,'dc','{}','body',0,'ambiguous',1725796740000);" +
      'INSERT INTO app_state(key,value) VALUES(\'worker:sources\',\'{"state":"failed","lastFinishedAt":"2026-09-08T11:58:00.000Z"}\');' +
      'INSERT INTO app_state(key,value) VALUES(\'runtime\',\'{"uncleanRestarts":["2026-09-08T11:40:00.000Z","2026-09-08T11:50:00.000Z","2026-09-08T11:59:00.000Z"]}\')',
  );
  const issues = listActionableIssues(db, config, now);
  expect(issues.map((issue) => issue.id)).toEqual(
    expect.arrayContaining(["openrouter", "delivery:7", "worker:sources", "runtime:restart-loop"]),
  );
  expect(issues.find((issue) => issue.id === "delivery:7")?.hint).toContain("any retry");
  expect(JSON.stringify(issues)).not.toContain("https://");
  db.close();
});

test("collection shrinkage is a distinct actionable issue", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  db.query("INSERT INTO sources(id,last_error,last_success,checked_at) VALUES('openrouter',?,?,?)").run(
    "Collection degraded: openrouter retained 4 of 10 records",
    "2026-09-08T11:00:00.000Z",
    "2026-09-08T12:00:00.000Z",
  );
  expect(listActionableIssues(db, config, Date.parse("2026-09-08T12:00:00.000Z"))).toContainEqual(
    expect.objectContaining({ id: "openrouter", kind: "collection_degraded", severity: "critical" }),
  );
  db.close();
});

test("an enabled API source with no first observation is actionable after a completed source cycle", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath, OPENAI_API_KEY: "fake-openai" });
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run(
    "worker:sources",
    JSON.stringify({ state: "idle", lastFinishedAt: new Date(now - 60_000).toISOString() }),
  );
  const issues = listActionableIssues(db, config, now);
  expect(issues).toContainEqual(
    expect.objectContaining({
      id: "openai",
      kind: "source_failed",
      message: expect.stringContaining("has no observation after the source worker completed a cycle"),
    }),
  );
  db.close();
});

test("stale workers and sending deliveries are actionable without automatic retries", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  db.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  db.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(8,1,'dc','{}','body',0,'sending',?)",
  ).run(now - 6 * 60 * 1000);
  db.query("INSERT INTO app_state(key,value) VALUES(?,?)").run(
    "worker:status",
    JSON.stringify({
      state: "running",
      lastStartedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      lastHeartbeatAt: new Date(now - 4 * 60 * 1000).toISOString(),
      heartbeatIntervalMs: 60_000,
    }),
  );
  const issues = listActionableIssues(db, config, now);
  expect(issues).toContainEqual(expect.objectContaining({ id: "worker:status:stale", kind: "worker_stale" }));
  expect(issues).toContainEqual(expect.objectContaining({ id: "delivery:8:stuck", kind: "delivery_stuck" }));
  expect(db.query("SELECT status FROM deliveries WHERE id=8").get()).toEqual({ status: "sending" });
  db.close();
});
