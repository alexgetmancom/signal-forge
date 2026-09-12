import { expect, test } from "bun:test";
import { loadConfig, settingsSchema } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { createHttpApp } from "../src/http.js";
import { openDatabase } from "../src/storage/database.js";

test("health is public, operational state requires token, MCP lists matching schemas", async () => {
  const db = openDatabase(":memory:"),
    config = loadConfig({
      CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
      MCP_TOKEN: "x".repeat(32),
    }),
    app = createHttpApp(config, db);
  const auth = { Authorization: `Bearer ${config.MCP_TOKEN}` };
  expect((await app.request("/readyz")).status).toBe(200);
  expect((await app.request("/reports/1")).status).toBe(401);
  expect((await app.request("/reports/1", { headers: auth })).status).toBe(404);
  db.exec(`INSERT INTO snapshots(id,source,collected_at,raw_json) VALUES(1,'web','2026-09-08T00:00:00.000Z','{}');
    INSERT INTO events(id,source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id)
    VALUES(1,'web','web','<script>','changed','{"strings":[]}','{"strings":["Claude Code"]}','2026-09-08T00:00:00.000Z',1)`);
  const report = await app.request("/reports/1", { headers: auth });
  expect(report.status).toBe(200);
  expect(await report.text()).toContain("&lt;script&gt;");
  expect((await app.request("/api/status")).status).toBe(401);
  const response = await app.request("/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.MCP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  // Only operations marked for the agent surface are listed, and a mutation that is not routine
  // delivery work is not among them.
  const tools = body.result.tools.map((t: { name: string }) => t.name);
  expect(tools).not.toContain("poll");
  expect(tools).not.toContain("clear_credential_circuit");
  expect(tools).not.toContain("guide");
  expect(tools).toEqual([
    "doctor",
    "status",
    "issues",
    "capabilities",
    "date_integrity",
    "deliveries",
    "deliveries_needing_verification",
    "require_delivery_verification",
    "resolve_delivery_verification",
    "suppressions",
    "events",
    "event",
    "stories",
    "models",
    "model",
    "hypotheses",
    "hypothesis",
    "lifecycle_deadlines",
    "lead_time",
    "signal_quality",
    "code_analytics",
    "deepseek_usage",
    "credential_circuits",
    "journal",
  ]);
  const batch = await app.request("/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.MCP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "tools/list" },
    ]),
  });
  expect(batch.status).toBe(200);
  expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  const notifications = await app.request("/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.MCP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", method: "ping" }]),
  });
  expect(notifications.status).toBe(202);
  expect((await app.request("/api/deliveries", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/deliveries/verification", { headers: auth })).status).toBe(200);
  const resolutionDb = openDatabase(":memory:");
  resolutionDb.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(7,'test',0,1)").run();
  resolutionDb
    .query(
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(7,7,'dc',?,'body',0,'ambiguous',0)",
    )
    .run(
      JSON.stringify({
        id: "dc",
        platform: "discord",
        channelId: "1",
        signals: ["launch", "codename", "evidence", "change"],
      }),
    );
  const resolutionApp = createHttpApp(config, resolutionDb);
  const resolution = await resolutionApp.request("/api/deliveries/7/verification/resolve", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "sent", externalId: "123" }),
  });
  expect(resolution.status).toBe(200);
  expect(resolutionDb.query("SELECT status,external_id FROM deliveries WHERE id=7").get()).toEqual({
    status: "sent",
    external_id: "123",
  });
  resolutionDb.close();
  expect((await app.request("/api/signal-quality", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/code-analytics", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/deepseek-usage", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/stories", { headers: auth })).status).toBe(200);
  db.close();
});
test("duplicate destination addresses fail configuration instead of doubling notifications", () => {
  expect(() =>
    settingsSchema.parse({
      destinations: [
        { id: "a", platform: "discord", channelId: "123", signals: ["launch", "codename", "evidence", "change"] },
        { id: "b", platform: "discord", channelId: "123", signals: ["launch", "codename", "evidence", "change"] },
      ],
    }),
  ).toThrow("once");
});

test("model, hypothesis and deadline HTTP routes use the authenticated operations", async () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({
    CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
    MCP_TOKEN: "x".repeat(32),
  });
  const auth = { Authorization: `Bearer ${config.MCP_TOKEN}` };
  const collect = (source: string, stream: Collection["stream"], records: Collection["records"]): Collection => ({
    source,
    stream,
    url: `https://example.test/${source}`,
    raw: records,
    appendOnly: true,
    records,
  });
  saveCollection(db, collect("openrouter", "openrouter", []), [], "2026-09-10T00:00:00Z");
  saveCollection(
    db,
    collect("openrouter", "openrouter", [{ id: "openai/gpt-6", name: "GPT-6", maker: "OpenAI" }]),
    [],
    "2026-09-10T00:01:00Z",
  );
  const app = createHttpApp(config, db);
  expect((await app.request("/api/models", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/models/openai/gpt-6", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/models/missing", { headers: auth })).status).toBe(404);
  expect((await app.request("/api/hypotheses?limit=10", { headers: auth })).status).toBe(200);
  expect((await app.request("/api/deadlines?days=30", { headers: auth })).status).toBe(200);
  db.close();
});
