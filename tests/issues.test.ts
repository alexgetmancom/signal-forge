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
