import { expect, test } from "bun:test";
import { capabilityReport } from "../src/capabilities.js";
import type { Destination } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { recordCredentialRejection } from "../src/credentials.js";
import { listActionableIssues } from "../src/reports/issues.js";
import { openDatabase } from "../src/storage/database.js";
import { aSource } from "./fixtures/build.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

test("capabilities distinguish disabled integrations from missing credentials", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  const destination: Destination = {
    id: "tg",
    platform: "telegram",
    chatId: "-100",
    signals: ["launch", "codename", "evidence", "change"],
  };
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
    "INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'openrouter','1970-01-01T00:00:00.000Z',1);" +
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(7,1,'dc','{}','body',0,'ambiguous','2024-09-08T11:59:00.000Z');" +
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

test("collection shrinkage is a distinct actionable issue once it repeats", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  db.query("INSERT INTO sources(id,last_error,last_success,checked_at,failures) VALUES('openrouter',?,?,?,1)").run(
    "Collection degraded: openrouter retained 4 of 10 records",
    "2026-09-08T11:00:00.000Z",
    "2026-09-08T12:00:00.000Z",
  );
  // One short answer rejected is the guard working; the arena serves several a week.
  const at = Date.parse("2026-09-08T12:00:00.000Z");
  expect(listActionableIssues(db, config, at).map((issue) => issue.id)).not.toContain("openrouter");
  db.query("UPDATE sources SET failures=2 WHERE id='openrouter'").run();
  expect(listActionableIssues(db, config, at)).toContainEqual(
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
  db.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test','1970-01-01T00:00:00.000Z',1)").run();
  db.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(8,1,'dc','{}','body',0,'sending',?)",
  ).run(new Date(now - 6 * 60 * 1000).toISOString());
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

test("a failed delivery stops being actionable once the channel sends again", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  db.query("INSERT INTO batches(id,source,digest,ready_at,sealed) VALUES(1,'openai',0,?,1)").run(
    new Date(now).toISOString(),
  );
  const add = (id: number, status: string) =>
    db
      .query(
        "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,error,updated_at) VALUES(?,1,'signals','{}','{}',?, ?,'Platform returned HTTP 403',?)",
      )
      .run(id, id, status, new Date(now).toISOString());

  add(1, "failed");
  expect(listActionableIssues(db, config, now).some((issue) => issue.id === "delivery:1")).toBe(true);
  // The permissions were fixed and the channel has carried something since.
  add(2, "sent");
  expect(listActionableIssues(db, config, now).some((issue) => issue.id === "delivery:1")).toBe(false);
  // A later failure is the current state of the wire and says so.
  add(3, "failed");
  expect(listActionableIssues(db, config, now).some((issue) => issue.id === "delivery:3")).toBe(true);
  db.close();
});

test("a refused credential is one issue, dated from the refusal, not one per source it stopped", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath, ARTIFICIAL_ANALYSIS_API_KEY: "test-key" });
  const report = capabilityReport(db, config).find((entry) => entry.id === "artificial-analysis");
  if (!report?.enabledSources.length) throw new Error("Artificial Analysis enables no source in the fixture");
  const [source] = report.enabledSources as [string];
  db.query("INSERT INTO sources(id,last_error,checked_at,failures) VALUES(?,'Source returned HTTP 401',?,1)").run(
    source,
    "2026-09-18T14:07:17.000Z",
  );
  recordCredentialRejection(db, {
    capabilityId: report.id,
    source,
    statusCode: 401,
    detail: "Source returned HTTP 401",
  });
  const openedAt = (db.query("SELECT opened_at FROM credential_circuits").get() as { opened_at: string }).opened_at;
  const issues = listActionableIssues(db, config, Date.parse("2026-09-19T00:00:00.000Z"));
  expect(issues.filter((issue) => issue.source === source)).toEqual([]);
  expect(issues.find((issue) => issue.id === `capability:${report.id}`)).toMatchObject({
    kind: "capability_rejected",
    firstSeenAt: openedAt,
  });
  db.close();
});

test("two sources of one family failing at once are one upstream, not two collectors", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: configPath });
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const at = "2026-09-08T11:59:00.000Z";
  aSource(db, "arena", { lastError: "Public page no longer exposes initialModels", checkedAt: at, failures: 3 });
  aSource(db, "arena-leaderboards", {
    lastError: "Public page no longer exposes leaderboards",
    checkedAt: at,
    failures: 3,
  });
  const issues = listActionableIssues(db, config, now);
  const arena = issues.find((issue) => issue.id === "arena");
  expect(arena?.group).toBe("Arena");
  expect(arena?.groupFailing).toBe(2);
  expect(arena?.hint).toContain("arena, arena-leaderboards");
  // A source failing alone carries no share of somebody else's outage.
  const alone = openDatabase(":memory:");
  aSource(alone, "arena", { lastError: "Public page no longer exposes initialModels", checkedAt: at, failures: 3 });
  expect(listActionableIssues(alone, config, now).find((issue) => issue.id === "arena")?.group).toBeUndefined();
  db.close();
  alone.close();
});
