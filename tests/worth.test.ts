import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = {
  id: "scouts",
  platform: "discord",
  channelId: "1",
  signals: ["launch", "codename", "rank", "change", "evidence", "release", "article"],
};

function suppressed(db: ReturnType<typeof openDatabase>): Record<string, string> {
  return Object.fromEntries(
    db
      .query<{ entity_id: string; reason: string }, []>(
        "SELECT e.entity_id,s.reason FROM suppressions s JOIN events e ON e.id=s.event_id",
      )
      .all()
      .map((row) => [row.entity_id, row.reason]),
  );
}

test("a board speaks for the leading places and for the top changing hands", () => {
  const db = openDatabase(":memory:");
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example/leaderboard",
    raw: [],
    records: [
      { id: "image-to-code:leader", name: "leader", category: "image-to-code/overall", rank: 1, score: 1700 },
      { id: "image-to-code:fourth", name: "fourth", category: "image-to-code/overall", rank: 4, score: 1600 },
    ],
  };
  saveCollection(db, board, [wire], "2026-09-14T00:00:00.000Z");
  board.records.push(
    { id: "image-to-code:second", name: "second", category: "image-to-code/overall", rank: 2, score: 1690 },
    { id: "image-to-code:fifth", name: "fifth", category: "image-to-code/overall", rank: 5, score: 1590 },
  );
  saveCollection(db, board, [wire], "2026-09-14T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-14T02:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["image-to-code:fifth"]).toBe("below_the_top_of_the_board");
  expect(reasons["image-to-code:second"]).toBeUndefined();
  db.close();
});

test("an arena entry that is a known model wired differently is not a sighting", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-14T00:00:00.000Z");
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://arena.example",
    raw: [],
    records: [{ id: "baseline", name: "baseline" }],
  };
  saveCollection(db, arena, [wire], "2026-09-14T00:10:00.000Z");
  arena.records.push(
    { id: "kimi-k3-gateway-max-v3", name: "kimi-k3-gateway-max-v3" },
    // A name that is not merely a known model plus its wiring stays a sighting.
    { id: "pointoni", name: "pointoni" },
  );
  saveCollection(db, arena, [wire], "2026-09-14T00:20:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-14T01:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["kimi-k3-gateway-max-v3"]).toBe("another_serving_of_a_known_model");
  expect(reasons.pointoni).toBeUndefined();
  db.close();
});

test("an alias row and a retitled row carry no card", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [
      { id: "~deepseek/deepseek-v4-flash-latest", name: "DeepSeek V4 Flash Latest", pricing: { prompt: "0.00000005" } },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { prompt: "0.00000005" } },
    ],
  };
  saveCollection(db, catalogue, [wire], "2026-09-14T00:00:00.000Z");
  catalogue.records = [
    {
      id: "~deepseek/deepseek-v4-flash-latest",
      name: "DeepSeek: DeepSeek V4 Flash Latest",
      pricing: { prompt: "0.00000004" },
    },
    // Nothing changed here but the title the catalogue displays.
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", pricing: { prompt: "0.00000005" } },
  ];
  saveCollection(db, catalogue, [wire], "2026-09-14T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-14T02:00:00.000Z"));

  expect(suppressed(db)).toEqual({
    "deepseek/deepseek-v4-flash": "display_label_only",
    "~deepseek/deepseek-v4-flash-latest": "alias_of_another_row",
  });
  expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
  db.close();
});

test("a newsroom speaks about models and stays quiet about the company", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "openai/gpt-6-astra", name: "OpenAI: GPT-6 Astra" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-14T00:00:00.000Z");

  // Real headlines from the week to 2026-09-14. The dashes in "GPT‑6" are the non-breaking ones the
  // newsroom actually publishes, which is why matching normalizes before it compares.
  const news: Collection = {
    source: "openai-news",
    stream: "news",
    url: "https://openai.com/news",
    raw: [],
    records: [{ id: "baseline", name: "Introducing an earlier post" }],
  };
  // The first reading of a source is a baseline and speaks for nothing.
  saveCollection(db, news, [wire], "2026-09-14T00:30:00.000Z");
  news.records = [
    ...news.records,
    ...[
      { id: "astra", name: "GPT‑6 Astra: The next generation in intelligence for work" },
      { id: "agents", name: "Introducing the Agents API" },
      { id: "board", name: "Paul Christiano joins OpenAI Foundation Board" },
      { id: "policy", name: "The AI policy window is open. We need to act." },
      { id: "storage", name: "Rapidly scaling online storage to serve over 1 billion ChatGPT users" },
    ],
  ];
  saveCollection(db, news, [wire], "2026-09-14T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-14T02:00:00.000Z"));

  const reasons = suppressed(db);
  // Named a model the catalogue knows, or the vendor introduced something itself.
  expect(reasons.astra).toBeUndefined();
  expect(reasons.agents).toBeUndefined();
  // A board appointment, an essay and an infrastructure writeup are about the company.
  expect(reasons.board).toBe("a_post_about_the_company_not_a_model");
  expect(reasons.policy).toBe("a_post_about_the_company_not_a_model");
  expect(reasons.storage).toBe("a_post_about_the_company_not_a_model");
  db.close();
});

test("a vendor blog is a newsroom, whichever vendor it belongs to", () => {
  const db = openDatabase(":memory:");
  const news: Collection = {
    source: "google-ai-blog",
    stream: "news",
    url: "https://blog.google/technology/ai/",
    raw: [],
    records: [{ id: "baseline", name: "Introducing an earlier post" }],
  };
  saveCollection(db, news, [wire], "2026-09-15T00:00:00.000Z");
  news.records = [
    ...news.records,
    // Both of the two posts this blog published by 2026-09-15.
    { id: "devfest", name: "DevFest is back" },
    { id: "astronaut", name: "Watch astronaut Christina Koch and Google’s James Manyika discuss space" },
  ];
  saveCollection(db, news, [wire], "2026-09-15T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-15T02:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons.devfest).toBe("a_post_about_the_company_not_a_model");
  expect(reasons.astronaut).toBe("a_post_about_the_company_not_a_model");
  db.close();
});
