import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { displayTitle } from "../src/events/naming.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection, Event } from "../src/events/types.js";
import { borrowedFacts } from "../src/events/worth.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = {
  id: "scouts",
  platform: "discord",
  channelId: "1",
  signals: [
    "launch",
    "codename",
    "rank",
    "change",
    "evidence",
    "release",
    "article",
    "feature",
    "safety",
    "research",
    "business",
  ],
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
  // A lab nobody follows is not heard from trending either: see isTrendingFromAnUnfollowedLab.
  expect(reasons["nex-agi/Nex-N2.5-mini"]).toBe("trending_from_an_unfollowed_lab");
  db.close();
});

test("weights with nothing to run and a router serving old weights stay quiet", () => {
  const db = openDatabase(":memory:");
  const lab: Collection = {
    source: "huggingface:tencent",
    stream: "weights",
    url: "https://huggingface.co/api/models?author=tencent",
    raw: [],
    appendOnly: true,
    records: [{ id: "tencent/anchor", name: "tencent/anchor", pipeline: "text-generation" }],
  };
  saveCollection(db, lab, [wire], "2026-09-17T14:00:00.000Z");
  // The two repositories of 2026-09-17, beside one that declares a pipeline.
  lab.records.push(
    { id: "tencent/WeVisDoc-2B", name: "tencent/WeVisDoc-2B", pipeline: null, category: null },
    { id: "tencent/Hunyuan-9", name: "tencent/Hunyuan-9", pipeline: "text-generation" },
  );
  saveCollection(db, lab, [wire], "2026-09-17T15:45:54.037Z");
  const router: Collection = {
    source: "huggingface-router",
    stream: "api-models",
    url: "https://huggingface.co/inference/models",
    raw: [],
    records: [{ id: "zai-org/anchor", name: "zai-org/anchor", created: "2025-01-01T00:00:00.000Z" }],
  };
  saveCollection(db, router, [wire], "2026-09-17T16:00:00.000Z");
  router.records.push(
    { id: "zai-org/GLM-4.7-FP8", name: "zai-org/GLM-4.7-FP8", created: "2025-12-22T13:41:42.000Z" },
    { id: "zai-org/GLM-5.4", name: "zai-org/GLM-5.4", created: "2026-09-15T00:00:00.000Z" },
  );
  saveCollection(db, router, [wire], "2026-09-17T17:05:20.440Z");
  prepareDeliveries(db, Date.parse("2026-09-17T19:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["tencent/WeVisDoc-2B"]).toBe("weights_with_nothing_to_run");
  expect(reasons["tencent/Hunyuan-9"]).toBeUndefined();
  expect(reasons["zai-org/GLM-4.7-FP8"]).toBe("weights_published_long_ago");
  expect(reasons["zai-org/GLM-5.4"]).toBeUndefined();
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

test("a platform listing another maker's model is a sighting until the maker lists it", () => {
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
  dashscope.records.push(
    { id: "glm-5.3", name: "glm-5.3" },
    { id: "kimi-k9", name: "kimi-k9" },
    { id: "qwen3.9-max", name: "qwen3.9-max" },
  );
  saveCollection(db, dashscope, [wire], "2026-09-15T10:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-15T12:00:00.000Z"));

  const bodies = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .map((row) => row.body)
    .join("\n");
  // Z.ai sells GLM-5.3 itself, so DashScope carrying it is not the first word on anything. An arena
  // entry under a released name is left alone: see isAlreadyOutAtItsMaker.
  expect(suppressed(db)["glm-5.3"]).toBe("already_out_at_its_maker");
  expect(bodies).toContain("No other tracked catalogue lists it yet");
  // The platform's own model is a launch, and a launch carries neither line.
  expect(bodies.match(/Already out · listed by|No other tracked catalogue/g)).toHaveLength(1);
  db.close();
});

test("a platform listing a model its maker published on Hugging Face long ago is not a sighting", () => {
  const db = openDatabase(":memory:");
  const weights: Collection = {
    source: "huggingface:zai-org",
    stream: "weights",
    url: "https://huggingface.co/zai-org",
    raw: [],
    appendOnly: true,
    records: [{ id: "zai-org/GLM-4.7-Flash", name: "zai-org/GLM-4.7-Flash", created: "2026-01-19T06:28:10.000Z" }],
  };
  saveCollection(db, weights, [wire], "2026-09-10T00:00:00.000Z");
  const garden: Collection = {
    source: "vertex-model-garden",
    stream: "api-models",
    url: "https://console.cloud.google.com/vertex-ai/model-garden",
    raw: [],
    records: [{ id: "google/gemini-anchor", name: "gemini-anchor" }],
  };
  saveCollection(db, garden, [wire], "2026-09-15T00:00:00.000Z");
  garden.records.push({ id: "zai-org/glm-4.7-flash", name: "glm-4.7-flash", maker: "Vertex AI" });
  saveCollection(db, garden, [wire], "2026-09-18T17:04:20.729Z");
  prepareDeliveries(db, Date.parse("2026-09-18T17:10:00.000Z"));

  expect(suppressed(db)["zai-org/glm-4.7-flash"]).toBe("already_out_at_its_maker");
  db.close();
});

test("an OpenRouter price is left to the daily recap, and a reseller's still speaks", () => {
  const db = openDatabase(":memory:");
  const prices = (source: string, price: string): Collection => ({
    source,
    stream: source === "openrouter" ? "openrouter" : "api-models",
    url: "https://example.test/models",
    raw: [],
    records: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", pricing: { completion: price } }],
  });
  for (const source of ["openrouter", "vercel-gateway"]) {
    saveCollection(db, prices(source, "0.0000032"), [wire], "2026-09-18T03:00:00.000Z");
    saveCollection(db, prices(source, "0.00000188672"), [wire], "2026-09-18T04:09:00.000Z");
  }
  prepareDeliveries(db, Date.parse("2026-09-18T05:00:00.000Z"));

  expect(
    db
      .query<{ source: string; reason: string }, []>(
        "SELECT e.source,s.reason FROM suppressions s JOIN events e ON e.id=s.event_id",
      )
      .all(),
  ).toEqual([{ source: "openrouter", reason: "left_to_the_daily_recap" }]);
  db.close();
});

test("a documentation example naming a model already known is not a sighting, a new one is", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "openrouter",
      stream: "openrouter",
      url: "https://openrouter.ai",
      raw: [],
      records: [{ id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" }],
    },
    [],
    "2026-09-09T00:00:00.000Z",
  );
  const page = (id: string, strings: string[]): Collection["records"][number] => ({ id, name: id, strings });
  const docs: Collection = {
    source: "codex-docs",
    stream: "web",
    url: "https://learn.chatgpt.com/docs",
    raw: [],
    records: [
      page("subagents", ['```toml name = "ui_fixer" model = "gpt-5.3-codex-spark" agent config```']),
      page("models", ["Pick a model for the agent in Codex."]),
    ],
  };
  saveCollection(db, docs, [wire], "2026-09-18T01:00:00.000Z");
  docs.records = [
    page("subagents", ['```toml name = "ui_fixer" model = "gpt-5.6-luna" agent config```']),
    page("models", ["Pick a model for the agent in Codex.", "GPT-5.7 Nova is the default model for the agent."]),
  ];
  saveCollection(db, docs, [wire], "2026-09-18T02:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T03:00:00.000Z"));

  expect(suppressed(db)).toEqual({ subagents: "names_only_known_models" });
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(1);
  db.close();
});

/** Entity ids of patch builds that reached a release-only room. */
function releaseCards(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .query<{ entity_id: string }, []>(
      `SELECT DISTINCT e.entity_id FROM delivery_events de JOIN events e ON e.id=de.event_id
       WHERE e.entity_id IN ('claude-code:2.1.275','claude-code:2.1.276','2','b')`,
    )
    .all()
    .map((row) => row.entity_id);
}

test("a tool patch build reaches nobody, whether it fixes or adds", () => {
  // Claude Code shipped 2.1.268 to 2.1.278 in nine days; the ones that added something reached the
  // signals channel as release cards, and a reader asked for them to stop.
  const db = openDatabase(":memory:");
  const releaseRoom: Destination = { id: "signals", platform: "discord", channelId: "2", signals: ["release"] };
  const build = (version: string, summary: string) => ({
    id: `claude-code:${version}`,
    name: `Claude Code ${version}`,
    version,
    published: "2026-09-18T00:00:00.000Z",
    summary,
  });
  const changelog: Collection = {
    source: "claude-code-changelog",
    stream: "news",
    url: "https://code.claude.com/docs/en/changelog",
    raw: [],
    appendOnly: true,
    records: [build("2.1.274", "Added a warning when memory is critical")],
  };
  saveCollection(db, changelog, [releaseRoom], "2026-09-17T00:00:00.000Z");
  changelog.records.push(
    build("2.1.275", "Added a send-now key Fixed a scroll bug"),
    build("2.1.276", "Fixed every request failing with 400 when the base URL points at a proxy"),
  );
  saveCollection(db, changelog, [releaseRoom], "2026-09-18T02:31:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T03:00:00.000Z"));

  expect(releaseCards(db)).toEqual([]);
  db.close();
});

test("a Codex patch stays quiet from its release and from its changelog", () => {
  const db = openDatabase(":memory:");
  const releaseRoom: Destination = { id: "signals", platform: "discord", channelId: "2", signals: ["release"] };
  const summary =
    "## Bug Fixes\n\n- New local TUI sessions now leave reasoning summaries disabled by default. (#46467)\n";
  const releases: Collection = {
    source: "github:openai/codex:releases",
    stream: "github",
    url: "https://github.com/openai/codex/releases",
    raw: [],
    appendOnly: true,
    records: [{ id: "1", name: "0.155.0", tag: "rust-v0.155.0", summary: "## New Features\n\n- Plugins." }],
  };
  const changelog: Collection = {
    source: "openai-codex-changelog",
    stream: "news",
    url: "https://developers.openai.com/codex/changelog",
    raw: [],
    appendOnly: true,
    records: [{ id: "a", name: "Codex CLI Release: 0.155.0", description: "New Features Plugins." }],
  };
  saveCollection(db, releases, [releaseRoom], "2026-09-17T00:00:00.000Z");
  saveCollection(db, changelog, [releaseRoom], "2026-09-17T00:00:00.000Z");
  releases.records.push({ id: "2", name: "0.155.1", tag: "rust-v0.155.1", summary });
  changelog.records.push({
    id: "b",
    name: "Codex CLI Release: 0.155.1",
    description: "Bug Fixes New local TUI sessions now leave reasoning summaries disabled by default.",
  });
  saveCollection(db, releases, [releaseRoom], "2026-09-18T20:03:04.000Z");
  saveCollection(db, changelog, [releaseRoom], "2026-09-18T20:40:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T21:00:00.000Z"));

  expect(releaseCards(db)).toEqual([]);
  db.close();
});

test("an arena entry under a name its maker already sells is still a sighting", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "mimo",
      stream: "api-models",
      url: "https://mimo.test",
      raw: [],
      records: [{ id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" }],
    },
    [],
    "2026-09-10T00:00:00.000Z",
  );
  const entry = (id: string, provider: string | null) => ({
    id,
    name: "mimo-v2.5-pro",
    model: "mimo-v2.5-pro",
    maker: "xiaomi",
    provider,
    output: { web: true },
    selectable: true,
  });
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://arena.ai",
    raw: [],
    records: [entry("019db650", "xiaomiV1")],
  };
  saveCollection(db, arena, [wire], "2026-09-17T00:00:00.000Z");
  arena.records.push(entry("01a0b31c", null));
  saveCollection(db, arena, [wire], "2026-09-18T06:06:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T06:07:00.000Z"));

  expect(suppressed(db)).toEqual({});
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deliveries").get()?.c).toBe(1);
  db.close();
});

test("a reseller filling in a price it had left empty is quiet, a price it moves still speaks", () => {
  const db = openDatabase(":memory:");
  const vercel = (pricing: Record<string, string>): Collection => ({
    source: "vercel-gateway",
    stream: "api-models",
    url: "https://ai-gateway.vercel.sh/v1/models",
    raw: [],
    records: [
      { id: "fish-audio/s1", name: "S1", maker: "fish-audio", pricing },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        pricing: { completion: pricing.moved ?? "0.0000032" },
      },
    ],
  });
  saveCollection(db, vercel({}), [wire], "2026-09-18T20:00:00.000Z");
  saveCollection(db, vercel({ input: "0.000015", moved: "0.00000188672" }), [wire], "2026-09-18T21:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T22:00:00.000Z"));

  expect(suppressed(db)["fish-audio/s1"]).toBe("a_reseller_filled_in_a_price");
  expect(suppressed(db)["deepseek/deepseek-v4-pro"]).toBeUndefined();
  db.close();
});

test("a vendor page naming none of its products is quiet, one naming a product is a sighting", () => {
  const db = openDatabase(":memory:");
  const pages = (paths: string[], source = "pages:anthropic"): Collection => ({
    source,
    stream: "pages",
    url: "https://www.anthropic.com",
    raw: [],
    records: paths.map((path) => ({ id: path, name: path, path })),
  });
  saveCollection(db, pages(["/news"]), [wire], "2026-09-18T19:00:00.000Z");
  saveCollection(db, pages(["/news/grok-voice-transcribe-2"], "pages:xai"), [wire], "2026-09-18T19:00:00.000Z");
  saveCollection(
    db,
    pages([
      "/news",
      "/news/accenture-embedded-evaluation",
      "/news/claude-for-life-sciences",
      "/docs/en/cli-sdks-libraries/cli/sessions-connect",
    ]),
    [wire],
    "2026-09-18T20:04:32.306Z",
  );
  saveCollection(
    db,
    pages(["/news/grok-voice-transcribe-2", "/news/grok-voice-transcribe-3"], "pages:xai"),
    [wire],
    "2026-09-18T20:04:32.306Z",
  );
  prepareDeliveries(db, Date.parse("2026-09-18T21:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["/news/accenture-embedded-evaluation"]).toBe("a_page_about_no_product");
  expect(reasons["/news/claude-for-life-sciences"]).toBeUndefined();
  expect(reasons["/news/grok-voice-transcribe-3"]).toBeUndefined();
  expect(reasons["/docs/en/cli-sdks-libraries/cli/sessions-connect"]).toBeUndefined();
  db.close();
});

test("a repository trending from a lab nobody follows here is quiet", () => {
  const db = openDatabase(":memory:");
  const trending: Collection = {
    source: "discovery:huggingface-trending",
    stream: "weights",
    url: "https://huggingface.co/models?sort=trending",
    raw: [],
    appendOnly: true,
    records: [{ id: "org/anchor", name: "org/anchor", created: "2026-09-16T00:00:00.000Z" }],
  };
  saveCollection(db, trending, [wire], "2026-09-18T20:00:00.000Z");
  trending.records.push({
    id: "Cactus-Compute/needle3",
    name: "Cactus-Compute/needle3",
    created: "2026-09-16T06:41:36.000Z",
  });
  saveCollection(db, trending, [wire], "2026-09-18T21:22:05.322Z");
  prepareDeliveries(db, Date.parse("2026-09-18T22:00:00.000Z"));

  expect(suppressed(db)["Cactus-Compute/needle3"]).toBe("trending_from_an_unfollowed_lab");
  db.close();
});

test("a released model with a search tool attached is another serving, a codename is a sighting", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "anthropic",
      stream: "api-models",
      url: "https://api.anthropic.com/v1/models",
      raw: [],
      records: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
    },
    [wire],
    "2026-09-10T00:00:00.000Z",
  );
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://lmarena.ai",
    raw: [],
    records: [{ id: "a", name: "claude-opus-5", maker: "anthropic" }],
  };
  saveCollection(db, arena, [wire], "2026-09-18T20:00:00.000Z");
  arena.records.push(
    { id: "b", name: "claude-opus-5-search", maker: "anthropic" },
    { id: "c", name: "river-route", maker: null },
  );
  saveCollection(db, arena, [wire], "2026-09-18T22:24:39.141Z");
  prepareDeliveries(db, Date.parse("2026-09-18T23:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons.b).toBe("another_serving_of_a_known_model");
  expect(reasons.c).toBeUndefined();
  db.close();
});

test("a Codex release told from its GitHub page stays quiet when the changelog carries it again", () => {
  const db = openDatabase(":memory:");
  const releases: Collection = {
    source: "github:openai/codex:releases",
    stream: "github",
    url: "https://github.com/openai/codex/releases",
    raw: [],
    appendOnly: true,
    records: [{ id: "1", name: "0.154.0", tag: "rust-v0.154.0", summary: "## New Features\n\n- Hooks." }],
  };
  const changelog: Collection = {
    source: "openai-codex-changelog",
    stream: "news",
    url: "https://developers.openai.com/codex/changelog",
    raw: [],
    appendOnly: true,
    records: [
      { id: "https://developers.openai.com/codex/changelog/#github-release-1", name: "Codex CLI Release: 0.154.0" },
    ],
  };
  saveCollection(db, releases, [wire], "2026-09-17T00:00:00.000Z");
  saveCollection(db, changelog, [wire], "2026-09-17T00:00:00.000Z");
  releases.records.push({
    id: "391752266",
    name: "0.155.0",
    tag: "rust-v0.155.0",
    summary: "## New Features\n\n- Plugins.",
  });
  saveCollection(db, releases, [wire], "2026-09-18T20:03:04.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T21:00:00.000Z"));
  changelog.records.push({
    id: "https://developers.openai.com/codex/changelog/#github-release-391752266",
    name: "Codex CLI Release: 0.155.0",
    description: "New Features Plugins.",
  });
  saveCollection(db, changelog, [wire], "2026-09-18T21:30:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-18T22:00:00.000Z"));

  expect(suppressed(db)).toMatchObject({
    "https://developers.openai.com/codex/changelog/#github-release-391752266": "same_release_on_another_page",
  });
  db.close();
});

test("a release named only by its version is titled with its repository", () => {
  expect(displayTitle("0.155.1", "github", "github:openai/codex:releases")).toBe("Codex 0.155.1");
  expect(displayTitle("v2.1.0", "github", "github:anthropics/claude-code:releases")).toBe("Claude Code 2.1.0");
  expect(displayTitle("Codex 1.0", "github", "github:openai/codex:releases")).toBe("Codex 1.0");
});

test("a reseller filling in a blank context is quiet, a context that moves still speaks", () => {
  const db = openDatabase(":memory:");
  const gateway = (rows: Record<string, unknown>[]): Collection => ({
    source: "vercel-gateway",
    stream: "api-models",
    url: "https://vercel.com/ai-gateway",
    raw: [],
    records: rows.map((row) => ({ id: String(row.id), name: String(row.name), ...row })),
  });
  saveCollection(
    db,
    gateway([
      { id: "typesafe-ai/jev", name: "Jev", context: 0 },
      { id: "openai/gpt-6", name: "GPT-6", context: 200000 },
    ]),
    [wire],
    "2026-09-17T00:00:00.000Z",
  );
  saveCollection(
    db,
    gateway([
      // "Context 0 → 32K" reached the public wire on 2026-09-19.
      { id: "typesafe-ai/jev", name: "Jev", context: 32000 },
      { id: "openai/gpt-6", name: "GPT-6", context: 400000 },
    ]),
    [wire],
    "2026-09-19T00:00:00.000Z",
  );
  prepareDeliveries(db, Date.parse("2026-09-19T02:00:00.000Z"));
  const reasons = suppressed(db);
  expect(reasons["typesafe-ai/jev"]).toBe("a_reseller_filled_in_a_price");
  expect(reasons["openai/gpt-6"]).toBeUndefined();
  db.close();
});

test("a field the source started sending on every record is the schema moving, not the models", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "command-code-models",
    stream: "api-models",
    url: "https://commandcode.example/models",
    raw: [],
    records: [
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", maker: "Command Code" },
      { id: "glm-5.2", name: "glm-5.2", maker: "Command Code" },
    ],
  };
  saveCollection(db, catalogue, [wire], "2026-09-22T10:00:00.000Z");
  catalogue.records = catalogue.records.map((record) => ({ ...record, capabilities: ["chat"] }));
  saveCollection(db, catalogue, [wire], "2026-09-22T11:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T12:00:00.000Z"));

  const reasons = suppressed(db);
  expect(reasons["gpt-5.4-mini"]).toBe("a_field_the_source_started_sending");
  expect(reasons["glm-5.2"]).toBe("a_field_the_source_started_sending");
  db.close();
});

test("a model followed here for weeks reaching one more venue is not a launch", () => {
  const db = openDatabase(":memory:");
  const maker: Collection = {
    source: "cohere-models",
    stream: "api-models",
    url: "https://cohere.example/models",
    raw: [],
    records: [{ id: "command-r", name: "Command R", maker: "Cohere" }],
  };
  saveCollection(db, maker, [wire], "2026-05-19T10:00:00.000Z");
  maker.records = [
    { id: "command-r", name: "Command R", maker: "Cohere" },
    { id: "command-a-plus", name: "Command A+", maker: "Cohere" },
  ];
  saveCollection(db, maker, [wire], "2026-05-20T10:00:00.000Z");
  const reseller: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "x-ai/grok-4", name: "xAI: Grok 4", maker: "xAI" }],
  };
  saveCollection(db, reseller, [wire], "2026-05-20T10:05:00.000Z");
  reseller.records = [
    { id: "x-ai/grok-4", name: "xAI: Grok 4", maker: "xAI" },
    { id: "cohere/command-a-plus", name: "Cohere: Command A+", maker: "Cohere" },
  ];
  saveCollection(db, reseller, [wire], "2026-09-22T10:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T12:00:00.000Z"));

  expect(suppressed(db)["cohere/command-a-plus"]).toBe("known_here_for_weeks");
  db.close();
});

test("one change that reached the whole list is told once, and a reset time redrawn by a minute is not told", () => {
  const db = openDatabase(":memory:");
  const plans = ["plus", "pro", "team"];
  const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];
  const list: Collection = {
    source: "codex-models",
    stream: "api-models",
    url: "https://chatgpt.com/backend-api/models",
    raw: [],
    records: models.map((id) => ({ id, name: id, maker: "OpenAI", plans: [...plans] })),
  };
  saveCollection(db, list, [wire], "2026-09-23T00:00:00.000Z");
  list.records = models.map((id) => ({ id, name: id, maker: "OpenAI", plans: [...plans, "promax"] }));
  saveCollection(db, list, [wire], "2026-09-23T00:24:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-23T01:00:00.000Z"));

  const reasons = suppressed(db);
  // The first of the herd carries the card; the other three are the same sentence.
  expect(Object.values(reasons).filter((reason) => reason === "one_change_across_the_whole_list").length).toBe(3);
  expect(reasons["gpt-6-astra"]).toBeUndefined();
  db.close();
});

test("the maker's own post is news beside the card, and an interface catching up is not", () => {
  const db = openDatabase(":memory:");
  const news: Destination = { ...wire, id: "news" };
  const catalogue: Collection = {
    source: "anthropic",
    stream: "api-models",
    url: "https://api.anthropic.com/v1/models",
    raw: [],
    records: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", maker: "Anthropic" }],
  };
  saveCollection(db, catalogue, [news], "2026-09-22T16:00:00.000Z");
  catalogue.records = [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", maker: "Anthropic" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", maker: "Anthropic" },
  ];
  saveCollection(db, catalogue, [news], "2026-09-22T16:20:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T16:25:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='1'").run();

  const post: Collection = {
    source: "anthropic-news",
    stream: "news",
    url: "https://www.anthropic.com/news",
    raw: [],
    records: [
      { id: "https://www.anthropic.com/economic-index", name: "The Anthropic Economic Index", maker: "Anthropic" },
    ],
  };
  saveCollection(db, post, [news], "2026-09-22T16:30:00.000Z");
  post.records = [
    ...post.records,
    { id: "https://www.anthropic.com/claude-opus-5-5", name: "Introducing Claude Opus 5.5", maker: "Anthropic" },
  ];
  saveCollection(db, post, [news], "2026-09-22T16:36:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T16:40:00.000Z"));
  db.query(
    "UPDATE deliveries SET status='sent',external_id='2' WHERE status='pending' AND body LIKE '%Introducing%'",
  ).run();

  const page: Collection = {
    source: "pages:anthropic",
    stream: "pages",
    url: "https://www.anthropic.com",
    raw: [],
    records: [{ id: "/news", name: "news", maker: "Anthropic" }],
  };
  saveCollection(db, page, [news], "2026-09-22T16:45:00.000Z");
  page.records = [...page.records, { id: "/claude-opus-5-5", name: "claude-opus-5-5", maker: "Anthropic" }];
  saveCollection(db, page, [news], "2026-09-22T16:50:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T16:55:00.000Z"));

  // An interface catching up with a model these readers were sent an hour ago is not news again.
  const notes: Collection = {
    source: "openai-chatgpt-release-notes",
    stream: "news",
    url: "https://help.openai.com/release-notes",
    raw: [],
    records: [{ id: "2026-09-22:first", name: "Projects in ChatGPT", audience: "developers", summary: "API updates" }],
  };
  saveCollection(db, notes, [news], "2026-09-22T17:00:00.000Z");
  notes.records = [
    ...notes.records,
    {
      id: "2026-09-22:opus-in-work",
      name: "Claude Opus 5.5 in Work and Codex",
      audience: "developers",
      summary: "Claude Opus 5.5 is now selectable in Work and Codex.",
    },
  ];
  saveCollection(db, notes, [news], "2026-09-23T06:05:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-23T06:10:00.000Z"));

  const reasons = suppressed(db);
  // The maker's own announcement is the link the card could not carry.
  expect(reasons["https://www.anthropic.com/claude-opus-5-5"]).toBeUndefined();
  const bodies = db
    .query<{ body: string }, []>("SELECT body FROM deliveries")
    .all()
    .map((row) => row.body)
    .join(" ");
  expect(bodies).toContain("Introducing Claude Opus 5.5");
  expect(reasons["2026-09-22:opus-in-work"]).toBe("names_only_known_models");
  // And the maker's own page about the same model, an hour later and in a batch of its own, is the
  // same link a second time.
  expect(reasons["/claude-opus-5-5"]).toBe("same_release_on_another_page");
  db.close();
});

test("a model from a maker this reader will never call stays out of the sightings", () => {
  const db = openDatabase(":memory:");
  const reseller: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "x-ai/grok-4", name: "xAI: Grok 4", maker: "xAI" }],
  };
  saveCollection(db, reseller, [wire], "2026-09-23T10:00:00.000Z");
  reseller.records = [
    { id: "x-ai/grok-4", name: "xAI: Grok 4", maker: "xAI" },
    { id: "upstage/solar-mini4", name: "Upstage: Solar Mini 4", maker: "Upstage" },
    { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", maker: "Moonshot" },
  ];
  saveCollection(db, reseller, [wire], "2026-09-23T11:00:00.000Z");

  const classes = Object.fromEntries(
    db
      .query<{ entity_id: string; signal: string }, []>("SELECT entity_id,signal FROM events WHERE kind='new'")
      .all()
      .map((row) => [row.entity_id, row.signal]),
  );
  expect(classes["upstage/solar-mini4"]).toBe("evidence");
  expect(classes["moonshotai/kimi-k3"]).toBe("codename");
  db.close();
});

test("a catalogue listing a model released four months ago is not a sighting", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    raw: [],
    records: [{ id: "mistralai/anchor-1", name: "Mistral: Anchor 1", created: "2026-09-19T00:00:00.000Z" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-19T00:00:00.000Z");
  // The row dates the model itself: a back catalogue arriving, not a release.
  catalogue.records.push({
    id: "mistralai/mistral-medium-3.2",
    name: "Mistral: Medium 3.2",
    created: "2026-05-01T00:00:00.000Z",
  });
  saveCollection(db, catalogue, [wire], "2026-09-21T18:21:28.890Z");
  prepareDeliveries(db, Date.parse("2026-09-21T18:30:00.000Z"));

  expect(suppressed(db)["mistralai/mistral-medium-3.2"]).toBe("released_long_before_this_listing");
  db.close();
});

test("a venue that carries no facts borrows them from a catalogue that does", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "models-dev",
    stream: "api-models",
    url: "https://models.dev",
    raw: [],
    records: [
      { id: "space-bunny-free", name: "Space Bunny Free", context: 1_048_576, input: ["image", "text", "video"] },
    ],
  };
  saveCollection(db, catalogue, [wire], "2026-09-23T14:23:48.883Z");
  const event = {
    id: 1,
    source: "opencode-go",
    stream: "api-models",
    entity_id: "space-bunny-free",
    kind: "new",
    after_json: JSON.stringify({ free: true, id: "space-bunny-free", maker: "OpenCode", model: "space-bunny" }),
    detected_at: "2026-09-23T14:29:00.939Z",
  } as unknown as Event;

  expect(borrowedFacts(db, event, "space-bunny")).toEqual({ context: 1_048_576, input: ["image", "text", "video"] });
  db.close();
});
