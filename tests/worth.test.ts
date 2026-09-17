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
  // Fifth place is outside the leading places by both guards now that they share one number, and
  // the notification filter is the one that reaches it first.
  expect(reasons["image-to-code:fifth"]).toBe("no_reader_facing_change");
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
    records: [
      { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" },
      { id: "x-ai/grok-4", name: "xAI: Grok 4" },
    ],
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
    // Grok 4.7 is not Grok 4 served some other way.
    { id: "grok-4-7", name: "grok-4-7" },
  );
  saveCollection(db, arena, [wire], "2026-09-14T00:20:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-14T01:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["kimi-k3-gateway-max-v3"]).toBe("another_serving_of_a_known_model");
  expect(reasons.pointoni).toBeUndefined();
  expect(reasons["grok-4-7"]).toBeUndefined();
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

test("a snapshot beside its model and a batch tier of a listed model stay quiet, a lone snapshot speaks", () => {
  const db = openDatabase(":memory:");
  const openai: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/v1/models",
    raw: [],
    records: [{ id: "gpt-anchor", name: "gpt-anchor" }],
  };
  saveCollection(db, openai, [wire], "2026-09-09T16:00:00.000Z");
  // The collection of 2026-09-09 17:07: two models, each with its dated snapshot, and one snapshot
  // whose plain row has not appeared.
  openai.records.push(
    { id: "gpt-image-2.5-flare", name: "gpt-image-2.5-flare" },
    { id: "gpt-image-2.5-flare-2026-09-08", name: "gpt-image-2.5-flare-2026-09-08" },
    { id: "gpt-solo-2026-09-08", name: "gpt-solo-2026-09-08" },
  );
  saveCollection(db, openai, [wire], "2026-09-09T17:07:50.185Z");
  const openrouter: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    raw: [],
    records: [{ id: "mistralai/codestral-2508", name: "Mistral: Codestral 2508" }],
  };
  saveCollection(db, openrouter, [wire], "2026-09-10T01:00:00.000Z");
  openrouter.records.push({ id: "mistralai/codestral-2508:batch", name: "Mistral: Codestral 2508 (batch)" });
  saveCollection(db, openrouter, [wire], "2026-09-10T01:46:05.401Z");
  prepareDeliveries(db, Date.parse("2026-09-10T03:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["gpt-image-2.5-flare-2026-09-08"]).toBe("another_tier_of_a_listed_model");
  expect(reasons["mistralai/codestral-2508:batch"]).toBe("another_tier_of_a_listed_model");
  expect(reasons["gpt-image-2.5-flare"]).toBeUndefined();
  expect(reasons["gpt-solo-2026-09-08"]).toBeUndefined();
  db.close();
});

test("trending weights a followed lab already published are not a second sighting", () => {
  const db = openDatabase(":memory:");
  const lab: Collection = {
    source: "huggingface:deepseek-ai",
    stream: "weights",
    url: "https://huggingface.co/api/models?author=deepseek-ai",
    raw: [],
    records: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "deepseek-ai/DeepSeek-V4.1-Flash" }],
  };
  saveCollection(db, lab, [wire], "2026-09-10T06:00:00.000Z");
  const trending: Collection = {
    source: "discovery:huggingface-trending",
    stream: "weights",
    url: "https://huggingface.co/api/models?sort=trendingScore",
    raw: [],
    appendOnly: true,
    records: [{ id: "anchor/model", name: "anchor/model" }],
  };
  saveCollection(db, trending, [wire], "2026-09-16T10:00:00.000Z");
  trending.records.push(
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "deepseek-ai/DeepSeek-V4.1-Flash" },
    { id: "nex-agi/Nex-N2.5-mini", name: "nex-agi/Nex-N2.5-mini" },
  );
  saveCollection(db, trending, [wire], "2026-09-16T11:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-16T13:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["deepseek-ai/DeepSeek-V4.1-Flash"]).toBe("published_by_a_followed_lab");
  expect(reasons["nex-agi/Nex-N2.5-mini"]).toBeUndefined();
  db.close();
});

test("a model named by several vendor pages is told once", () => {
  const db = openDatabase(":memory:");
  const site = (source: string, anchor: string): Collection => ({
    source,
    stream: "pages",
    url: `https://${source}.example/sitemap.xml`,
    raw: [],
    records: [{ id: anchor, name: anchor }],
  });
  const deepmind = site("pages:deepmind", "/anchor");
  saveCollection(db, deepmind, [wire], "2026-09-15T16:00:00.000Z");
  deepmind.records.push({ id: "/models/model-cards/gemini-3-8-audio", name: "/models/model-cards/gemini-3-8-audio" });
  saveCollection(db, deepmind, [wire], "2026-09-15T17:31:26.385Z");
  prepareDeliveries(db, Date.parse("2026-09-15T17:50:00.000Z"));

  const google = site("pages:google", "/anchor");
  saveCollection(db, google, [wire], "2026-09-15T17:00:00.000Z");
  google.records.push(
    { id: "/gemini-api/docs/models/gemini-3.8-live", name: "/gemini-api/docs/models/gemini-3.8-live" },
    {
      id: "/gemini-api/docs/models/gemini-3.8-live-extended-thinking",
      name: "/gemini-api/docs/models/gemini-3.8-live-extended-thinking",
    },
    // A different model on the same site is its own news.
    { id: "/gemini-api/docs/models/gemini-3-pro", name: "/gemini-api/docs/models/gemini-3-pro" },
    // So is another tier at the version just told.
    { id: "/gemini-api/docs/models/gemini-3.8-pro", name: "/gemini-api/docs/models/gemini-3.8-pro" },
  );
  saveCollection(db, google, [wire], "2026-09-15T18:05:17.788Z");
  prepareDeliveries(db, Date.parse("2026-09-15T19:30:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["/models/model-cards/gemini-3-8-audio"]).toBeUndefined();
  expect(reasons["/gemini-api/docs/models/gemini-3.8-live"]).toBe("another_page_about_the_same_model");
  expect(reasons["/gemini-api/docs/models/gemini-3.8-live-extended-thinking"]).toBe(
    "another_page_about_the_same_model",
  );
  expect(reasons["/gemini-api/docs/models/gemini-3-pro"]).toBeUndefined();
  expect(reasons["/gemini-api/docs/models/gemini-3.8-pro"]).toBeUndefined();
  db.close();
});

test("a platform listing another maker's model names where it already was", () => {
  const db = openDatabase(":memory:");
  const zai: Collection = {
    source: "zai",
    stream: "api-models",
    url: "https://api.z.ai/api/paas/v4/models",
    raw: [],
    records: [{ id: "glm-5.3", name: "glm-5.3" }],
  };
  saveCollection(db, zai, [wire], "2026-09-10T00:00:00.000Z");
  const dashscope: Collection = {
    source: "dashscope",
    stream: "api-models",
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    raw: [],
    records: [{ id: "qwen-anchor", name: "qwen-anchor" }],
  };
  saveCollection(db, dashscope, [wire], "2026-09-15T00:00:00.000Z");
  dashscope.records.push({ id: "glm-5.3", name: "glm-5.3" }, { id: "qwen3.9-max", name: "qwen3.9-max" });
  saveCollection(db, dashscope, [wire], "2026-09-15T10:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-15T12:00:00.000Z"));

  const bodies = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .map((row) => row.body)
    .join("\n");
  expect(bodies).toContain("Already out · listed by Z.ai API");
  // The platform's own model is a launch, and a launch carries neither line.
  expect(bodies.match(/Already out · listed by|No other tracked catalogue/g)).toHaveLength(1);
  db.close();
});
