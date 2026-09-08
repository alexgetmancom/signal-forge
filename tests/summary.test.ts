import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { type RecordData, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";
import { fillSummaries, sanitize, summarize } from "../src/summary.js";

const fixture = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = { ...loadConfig({ CONFIG_PATH: fixture }), DEEPSEEK_API_KEY: "key" };

function reply(content: string) {
  return async () => Response.json({ choices: [{ message: { content } }] });
}

test("model output cannot carry handles or links into a message", () => {
  expect(sanitize("Ping @everyone see https://evil.test now")).toBe("Ping everyone see now");
  expect(sanitize("**bold** `code` <@&1>")).toBe("bold code 1");
});
test("an unclear diff produces no sentence rather than a guess", async () => {
  expect(await summarize("noise", config, reply("UNCLEAR"))).toBeNull();
  expect(await summarize("noise", config, reply("  Renamed two fields.  "))).toBe("Renamed two fields.");
  // Without a key the feature is simply off.
  expect(await summarize("noise", { ...config, DEEPSEEK_API_KEY: undefined }, reply("x"))).toBeNull();
});
test("a summary is attached to a long diff and skipped for a short one", async () => {
  const db = openDatabase(":memory:");
  const destination = { id: "d", platform: "discord" as const, channelId: "1", streams: ["api-models" as const] };
  const long: RecordData = { id: "m", name: "Model" };
  for (let index = 0; index < 20; index++) long[`field${index}`] = "before";
  const collection = { source: "openrouter", stream: "api-models", url: "https://e.test", raw: [], records: [long] };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z");
  const after: RecordData = { ...long };
  for (let index = 0; index < 20; index++) after[`field${index}`] = "after";
  collection.records = [after];
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z");

  const written = await fillSummaries(db, config, reply("Twenty fields were rewritten."));
  expect(written).toBe(1);
  const stored = db.query<{ text: string }, []>("SELECT text FROM summaries").get();
  expect(stored?.text).toBe("Twenty fields were rewritten.");
});
test("a failing summariser never breaks the batch", async () => {
  const db = openDatabase(":memory:");
  const destination = { id: "d", platform: "discord" as const, channelId: "1", streams: ["api-models" as const] };
  const record: RecordData = { id: "m", name: "Model" };
  for (let index = 0; index < 20; index++) record[`field${index}`] = "before";
  const collection = { source: "openrouter", stream: "api-models", url: "https://e.test", raw: [], records: [record] };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z");
  const changed: RecordData = { ...record };
  for (let index = 0; index < 20; index++) changed[`field${index}`] = "after";
  collection.records = [changed];
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z");
  const exploding = async () => {
    throw new Error("deepseek is down");
  };
  expect(await fillSummaries(db, config, exploding)).toBe(0);
  // The call is still counted, so a broken provider cannot drain the budget silently in a loop.
  const spend = db.query<{ value: string }, []>("SELECT value FROM app_state WHERE key LIKE 'summary_calls_%'").get();
  expect(Number(spend?.value)).toBeGreaterThan(0);
});
