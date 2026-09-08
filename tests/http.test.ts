import { expect, test } from "bun:test";
import { loadConfig, settingsSchema } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { openDatabase } from "../src/storage/database.js";

test("health is public, operational state requires token, MCP lists matching schemas", async () => {
  const db = openDatabase(":memory:"),
    config = loadConfig({
      CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
      MCP_TOKEN: "x".repeat(32),
    }),
    app = createHttpApp(config, db);
  expect((await app.request("/readyz")).status).toBe(200);
  expect((await app.request("/reports/1")).status).toBe(404);
  db.exec(`INSERT INTO snapshots(id,source,collected_at,raw_json) VALUES(1,'web','2026-09-08','{}');
    INSERT INTO events(id,source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id)
    VALUES(1,'web','web','<script>','changed','{"strings":[]}','{"strings":["Claude Code"]}','2026-09-08',1)`);
  const report = await app.request("/reports/1");
  expect(report.status).toBe(200);
  expect(await report.text()).toContain("&lt;script&gt;");
  expect((await app.request("/api/status")).status).toBe(401);
  const response = await app.request("/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.MCP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["status", "events", "event", "deliveries"]);
  db.close();
});
test("duplicate destination addresses fail configuration instead of doubling notifications", () => {
  expect(() =>
    settingsSchema.parse({
      destinations: [
        { id: "a", platform: "discord", channelId: "123", streams: ["news"] },
        { id: "b", platform: "discord", channelId: "123", streams: ["github"] },
      ],
    }),
  ).toThrow("once");
});
