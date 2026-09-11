import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { type RecordData, saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";
import { fillSummaries, sanitize, summarize } from "../src/summary.js";

const fixture = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = { ...loadConfig({ CONFIG_PATH: fixture }), DEEPSEEK_API_KEY: "key" };

function reply(content: string, seen?: { body?: string }, usage?: Record<string, number>) {
  return async (_url: string, init?: RequestInit) => {
    if (seen) seen.body = String(init?.body ?? "");
    return Response.json({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });
  };
}

test("model output cannot carry handles or links into a message", () => {
  expect(sanitize("Ping @everyone see https://evil.test now")).toBe("Ping everyone see now");
  expect(sanitize("**bold** `code` <@&1>")).toBe("bold code 1");
});
test("an unclear diff produces no sentence rather than a guess", async () => {
  expect((await summarize("noise", config, reply("UNCLEAR"))).text).toBeNull();
  expect((await summarize("noise", config, reply("UNC"))).text).toBeNull();
  expect((await summarize("noise", config, reply("UNCLE"))).text).toBeNull();
  expect((await summarize("noise", config, reply("Changed."))).text).toBeNull();
  expect((await summarize("noise", config, reply("  Renamed two fields.  "))).text).toBe("Renamed two fields.");
  // Without a key the feature is simply off.
  expect((await summarize("noise", { ...config, DEEPSEEK_API_KEY: undefined }, reply("x"))).outcome).toBe("disabled");
});
test("GitHub summaries receive the commit context", async () => {
  const seen: { body?: string } = {};
  const summary = await summarize(
    'CURRENT:\n{"name":"Use the originating model when recording conversation history"}',
    config,
    reply("Conversation history now stores the originating model.", seen),
    {
      source: "github:openai/codex:commits",
      stream: "github",
      kind: "new",
      title: "Use the originating model when recording conversation history",
    },
  );
  expect(summary.text).toBe("Conversation history now stores the originating model.");
  const request = JSON.parse(seen.body ?? "{}") as { messages?: { role: string; content: string }[] };
  expect(request.messages?.[0]?.content).toContain("For a GitHub repository change");
  expect(request.messages?.[1]?.content).toContain("TITLE: Use the originating model");
});
test("a summary is attached to a long diff and skipped for a short one", async () => {
  const db = openDatabase(":memory:");
  const destination = {
    id: "d",
    platform: "discord" as const,
    channelId: "1",
    signals: ["launch", "codename", "evidence", "change"] as ("launch" | "codename" | "evidence" | "change")[],
  };
  const long: RecordData = { id: "m", name: "Model" };
  for (let index = 0; index < 20; index++) long[`field${index}`] = "before";
  const collection = { source: "openrouter", stream: "api-models", url: "https://e.test", raw: [], records: [long] };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z");
  const after: RecordData = { ...long };
  for (let index = 0; index < 20; index++) after[`field${index}`] = "after";
  collection.records = [after];
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z");

  const written = await fillSummaries(
    db,
    config,
    reply("Twenty fields were rewritten.", undefined, {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 20,
      prompt_cache_miss_tokens: 80,
    }),
    new Date("2026-09-08T12:00:00.000Z"),
  );
  expect(written).toBe(1);
  const stored = db.query<{ text: string }, []>("SELECT text FROM summaries").get();
  expect(stored?.text).toBe("Twenty fields were rewritten.");
  expect(
    db
      .query<
        { outcome: string; prompt_tokens: number; completion_tokens: number; cost_basis: string; cost_usd: number },
        []
      >("SELECT outcome,prompt_tokens,completion_tokens,cost_basis,cost_usd FROM deepseek_usage")
      .get(),
  ).toMatchObject({ outcome: "summarized", prompt_tokens: 100, completion_tokens: 10, cost_basis: "exact" });
  expect(db.query<{ cost_usd: number }, []>("SELECT cost_usd FROM deepseek_usage").get()?.cost_usd).toBeCloseTo(
    0.00001806,
    10,
  );
});
test("a failing summariser never breaks the batch", async () => {
  const db = openDatabase(":memory:");
  const destination = {
    id: "d",
    platform: "discord" as const,
    channelId: "1",
    signals: ["launch", "codename", "evidence", "change"] as ("launch" | "codename" | "evidence" | "change")[],
  };
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
  const now = new Date("2026-09-08T12:00:00.000Z");
  expect(await fillSummaries(db, config, exploding, now)).toBe(0);
  expect(await fillSummaries(db, config, exploding, now)).toBe(0);
  // The first failed call is recorded, so a broken provider cannot drain the budget in a loop.
  expect(db.query("SELECT outcome,error_type FROM deepseek_usage").get()).toEqual({
    outcome: "failed",
    error_type: "Error",
  });
});
