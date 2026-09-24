import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { RecordData } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";
import { completeSentences, fillSummaries, rolloutGroups, sanitize, summarize } from "../src/summary.js";

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
  for (let attempt = 0; attempt < 4; attempt++) expect(await fillSummaries(db, config, exploding, now)).toBe(0);
  // Every call is recorded, so a broken provider cannot drain the budget in a loop; a failure is
  // worth asking again about exactly once, and the ceiling stops the third.
  expect(db.query("SELECT attempt,outcome,error_type FROM deepseek_usage ORDER BY attempt").all()).toEqual([
    { attempt: 1, outcome: "failed", error_type: "Error" },
    { attempt: 2, outcome: "failed", error_type: "Error" },
  ]);
});

test("an answer is asked for twice at most, and never once it has said something", async () => {
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
  const now = new Date("2026-09-08T12:00:00.000Z");
  // The model is reached and says nothing usable, so the event keeps its second chance...
  expect(await fillSummaries(db, config, reply("UNCLEAR"), now)).toBe(0);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deepseek_usage").get()?.n).toBe(1);
  // ...and spends it on an answer, which settles the event for good.
  expect(await fillSummaries(db, config, reply("Twenty fields changed."), now)).toBe(1);
  expect(await fillSummaries(db, config, reply("Asked a third time."), now)).toBe(0);
  expect(db.query("SELECT attempt,outcome FROM deepseek_usage ORDER BY attempt").all()).toEqual([
    { attempt: 1, outcome: "unclear" },
    { attempt: 2, outcome: "summarized" },
  ]);
});

test("a sentence the model could not finish is not published", () => {
  // The output ceiling cuts these: 33 of 71 summaries stored on production ended this way.
  expect(completeSentences("Nvidia added a new public Hug")).toBeNull();
  expect(completeSentences("OpenRouter raised prices: prompt, completion and")).toBeNull();
  // What finished is kept, and the unfinished tail is dropped rather than shown.
  expect(completeSentences("OpenRouter raised two prices. It also removed the over")).toBe(
    "OpenRouter raised two prices.",
  );
  expect(completeSentences("The listing moved to version 2.4.")).toBe("The listing moved to version 2.4.");
});

test("a summary that prices in per-token units says nothing the card does not already say", () => {
  // The card prints the same figures underneath as dollars per million tokens.
  expect(completeSentences("DeepSeek V4 Pro lowered pricing: prompt to 0.00000066.")).toBeNull();
  expect(completeSentences("DeepSeek V4 Pro lowered its prompt and completion prices.")).toBe(
    "DeepSeek V4 Pro lowered its prompt and completion prices.",
  );
});

test("a short event whose title an English reader cannot read is summarised in English", async () => {
  const db = openDatabase(":memory:");
  const destination = {
    id: "d",
    platform: "discord" as const,
    channelId: "1",
    signals: ["launch", "change"] as ("launch" | "change")[],
  };
  const collection = {
    source: "openrouter",
    stream: "api-models",
    url: "https://e.test",
    raw: [],
    records: [{ id: "m", name: "通义千问 模型" }] as RecordData[],
  };
  saveCollection(db, collection, [destination], "2026-09-08T10:00:00.000Z");
  collection.records = [{ id: "m", name: "通义千问 模型", price: "1" }];
  saveCollection(db, collection, [destination], "2026-09-08T10:05:00.000Z");
  const seen: { body?: string } = {};
  const written = await fillSummaries(
    db,
    config,
    reply("Qwen model price set.", seen),
    new Date("2026-09-08T12:00:00.000Z"),
  );
  expect(written).toBeGreaterThan(0);
  expect(seen.body).toContain("Always write in English");
});

test("pages that changed together are summarised once, for the rollout rather than the page", async () => {
  const db = openDatabase(":memory:");
  const destination = {
    id: "d",
    platform: "discord" as const,
    channelId: "1",
    signals: ["launch", "codename", "evidence", "change"] as ("launch" | "codename" | "evidence" | "change")[],
  };
  const page = (id: string, model: string): RecordData => {
    const record: RecordData = { id, name: id, url: `https://docs.test/${id}` };
    for (let index = 0; index < 20; index++) record[`block${index}`] = `${model} paragraph ${index}`;
    return record;
  };
  const ids = ["overview", "model-selection", "limits"];
  const collection = {
    source: "codex-docs",
    stream: "pages",
    url: "https://docs.test",
    raw: [],
    records: ids.map((id) => page(id, "gpt-5.6-terra")),
  };
  saveCollection(db, collection, [destination], "2026-09-22T10:00:00.000Z");
  collection.records = ids.map((id) => page(id, "gpt-6-sol"));
  saveCollection(db, collection, [destination], "2026-09-22T10:05:00.000Z");

  let calls = 0;
  const written = await fillSummaries(
    db,
    config,
    async (_url: string, init?: RequestInit) => {
      calls++;
      expect(String(init?.body ?? "")).toContain("three short factual sentences");
      return Response.json({
        choices: [{ message: { content: "Codex now defaults to GPT-6 Sol. GPT-5.5 retires on 14 October." } }],
      });
    },
    new Date("2026-09-22T10:06:00.000Z"),
  );
  expect(calls).toBe(1);
  expect(written).toBe(3);
  expect(rolloutGroups([]).size).toBe(0);
  const texts = db.query<{ text: string }, []>("SELECT text FROM summaries").all();
  expect(texts.length).toBe(3);
  expect(texts.every((row) => row.text.startsWith("Codex now defaults"))).toBe(true);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deepseek_usage").get()?.count).toBe(1);
});

test("a sentence and the attempt that paid for it are written together or not at all", async () => {
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

  // The provider answers, and storing the sentence then fails. The table stays readable, so the
  // pending query still finds the event; only the write into it is refused.
  db.exec("CREATE TRIGGER summaries_refuse BEFORE INSERT ON summaries BEGIN SELECT RAISE(ABORT, 'disk is full'); END");
  const answering = (async () =>
    Response.json({
      choices: [{ message: { content: "The model context window doubled today." } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })) as unknown as typeof fetch;
  expect(await fillSummaries(db, config, answering, new Date("2026-09-08T12:00:00.000Z"))).toBe(0);

  // The attempt is left retryable rather than claiming a sentence nothing can find. Settling it as
  // `summarized` is what used to strand the event: the pending query skips any settled attempt, so
  // the card would ship the empty version of itself and never be filled in.
  expect(db.query("SELECT outcome FROM deepseek_usage").all()).toEqual([{ outcome: "failed" }]);
  db.close();
});
