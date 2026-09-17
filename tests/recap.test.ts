import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import { renderRecapLines } from "../src/events/render/lifecycle.js";
import type { Collection } from "../src/events/types.js";
import { lastRecapPeriod, recapContext, scheduleRecaps } from "../src/recap.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "wire", platform: "discord", channelId: "1", signals: ["launch", "change"] };
const config = { destinations: [wire] } as never;

test("a recap covers the week that ended on the most recent Sunday evening", () => {
  // Wednesday: the last complete week ended on Sunday the 13th.
  expect(lastRecapPeriod(Date.parse("2026-09-16T09:00:00.000Z"))).toBe("2026-09-13T18:00:00.000Z");
  // Sunday morning, before the hour: the week that ended is the one before.
  expect(lastRecapPeriod(Date.parse("2026-09-13T09:00:00.000Z"))).toBe("2026-09-06T18:00:00.000Z");
});

function week(db: ReturnType<typeof openDatabase>) {
  const catalogue: Collection = {
    source: "openai",
    stream: "api-models",
    url: "https://api.openai.com/models",
    raw: [],
    records: [{ id: "baseline", name: "Baseline", pricing: { prompt: "1" } }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records.push({ id: "gpt-6-astra", name: "GPT-6 Astra" });
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");
  catalogue.records[0] = { id: "baseline", name: "Baseline", pricing: { prompt: "0.4" } };
  saveCollection(db, catalogue, [wire], "2026-09-10T10:00:00.000Z");
}

test("the week reads back as what arrived and what moved furthest", () => {
  const db = openDatabase(":memory:");
  week(db);
  const context = recapContext(db, "2026-09-13T18:00:00.000Z");
  expect(context.arrivals).toEqual([{ vendor: "OpenAI", names: ["GPT-6 Astra"] }]);
  expect(context.arrivalCount).toBe(1);
  expect(context.priceMoves[0]).toMatchObject({ name: "Baseline", cheaper: true });
  expect(Math.round((context.priceMoves[0]?.percent ?? 0) * 100)).toBe(60);
});

test("early sightings are counted as subjects, not as observations", () => {
  const db = openDatabase(":memory:");
  const arena: Collection = {
    source: "arena",
    stream: "arena",
    url: "https://arena.example",
    raw: [],
    records: [{ id: "baseline", name: "Baseline" }],
  };
  saveCollection(db, arena, [wire], "2026-09-08T00:00:00.000Z");
  // The same entry, seen again and again all week, is one thing the scouts saw.
  for (const [index, at] of ["2026-09-09", "2026-09-10", "2026-09-11"].entries()) {
    arena.records[1] = { id: "spicy-mayo", name: "spicy-mayo", rank: index + 1 };
    saveCollection(db, arena, [wire], `${at}T00:00:00.000Z`);
  }
  expect(recapContext(db, "2026-09-13T18:00:00.000Z").codenameCount).toBe(1);
});

test("the recap is queued once for a period and never twice", () => {
  const db = openDatabase(":memory:");
  week(db);
  const now = Date.parse("2026-09-14T09:00:00.000Z");
  expect(scheduleRecaps(db, config, now)).toEqual(["week"]);
  expect(scheduleRecaps(db, config, now)).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM batches WHERE kind='weekly_recap'").get()).toEqual({ n: 1 });

  prepareDeliveries(db, now);
  const body = db
    .query<{ body: string }, [string]>("SELECT body FROM deliveries d JOIN batches b ON b.id=d.batch_id WHERE b.kind=?")
    .get("weekly_recap")?.body;
  expect(body).toContain("1 model arrived");
  expect(body).toContain("GPT-6 Astra");
});

test("a week with nothing in it is not a message", () => {
  const db = openDatabase(":memory:");
  expect(scheduleRecaps(db, config, Date.parse("2026-09-14T09:00:00.000Z"))).toEqual([]);
});

test("a week is read back by maker, with training checkpoints and re-keyed rows left out", () => {
  const db = openDatabase(":memory:");
  const weights: Collection = {
    source: "huggingface:nvidia",
    stream: "weights",
    url: "https://huggingface.co/nvidia",
    raw: [],
    records: [{ id: "nvidia/Older", name: "nvidia/Older", pipeline: "text-generation" }],
  };
  saveCollection(db, weights, [wire], "2026-09-08T10:00:00.000Z");
  weights.records = [
    { id: "nvidia/Older", name: "nvidia/Older", pipeline: "text-generation" },
    { id: "nvidia/Nemotron-4-Ultra", name: "nvidia/Nemotron-4-Ultra", pipeline: "text-generation" },
    // Two checkpoints of one training run, and a row the collector had to number because the
    // catalogue already carries it. Neither is a release.
    { id: "nvidia/Nemotron-4-Ultra-Math-SFT", name: "nvidia/Nemotron-4-Ultra-Math-SFT", pipeline: "text-generation" },
    { id: "nvidia/Nemotron-4-Ultra-Math-RL", name: "nvidia/Nemotron-4-Ultra-Math-RL", pipeline: "text-generation" },
    { id: "nvidia/Nemotron-4-Ultra (1)", name: "nvidia/Nemotron-4-Ultra (1)", pipeline: "text-generation" },
    // A parametric 3D head: a real publication by a real maker, and not a model anyone can call.
    { id: "google/gnm-v4", name: "google/gnm-v4", pipeline: null, tags: ["3d", "computer-vision"] },
    // Somebody's fine-tune of a model that already arrived.
    {
      id: "nvidia/Nemotron-4-Ultra-Tennis",
      name: "nvidia/Nemotron-4-Ultra-Tennis",
      pipeline: "any-to-any",
      tags: ["base_model:finetune:nvidia/Nemotron-4-Ultra"],
    },
  ];
  saveCollection(db, weights, [wire], "2026-09-09T10:00:00.000Z");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "sakana/fugu-mini", name: "Sakana: Fugu Mini" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");
  catalogue.records.push({ id: "sakana/fugu-max", name: "Sakana: Fugu Max" });
  saveCollection(db, catalogue, [wire], "2026-09-10T10:00:00.000Z");

  const context = recapContext(db, "2026-09-13T18:00:00.000Z");
  expect(context.arrivalCount).toBe(2);
  // The registry namespace names the maker; a maker the table has never heard of names itself.
  expect(context.arrivals).toEqual([
    { vendor: "NVIDIA", names: ["Nemotron 4 Ultra"] },
    { vendor: "Sakana", names: ["Fugu Max"] },
  ]);
});

test("a price line is what a reader pays, and says nothing when the rows disagree", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [
      { id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B", pricing: { prompt: "0.00000012", completion: "0.00000024" } },
      { id: "inception/mercury", name: "Inception: Mercury", pricing: { prompt: "0.0000002" } },
      { id: "inception/mercury-preview", name: "Inception: Mercury Preview", pricing: { prompt: "0.00000004" } },
      // A cached-read rate is not the price of the week, however far it moves.
      { id: "ibm/granite", name: "IBM: Granite", pricing: { prompt: "0.0000001", input_cache_read: "0.00000005" } },
    ],
  };
  // A price line is only spent on a model something other than a price list knows about.
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example/leaderboard",
    raw: [],
    records: [
      { id: "text:overall:qwen3-14b", name: "Qwen3 14B", rank: 40 },
      { id: "text:overall:mercury", name: "Mercury", rank: 41 },
      { id: "text:overall:granite", name: "Granite", rank: 42 },
    ],
  };
  saveCollection(db, board, [wire], "2026-09-08T09:00:00.000Z");
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records = [
    { id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B", pricing: { prompt: "0.0000002275", completion: "0.00000091" } },
    // The standard row falls to the discounted rate while the preview row rises off it: one of
    // these is the week's news and nothing here says which.
    { id: "inception/mercury", name: "Inception: Mercury", pricing: { prompt: "0.00000004" } },
    { id: "inception/mercury-preview", name: "Inception: Mercury Preview", pricing: { prompt: "0.0000002" } },
    { id: "ibm/granite", name: "IBM: Granite", pricing: { prompt: "0.0000001", input_cache_read: "0.000000015" } },
  ];
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");

  const context = recapContext(db, "2026-09-13T18:00:00.000Z");
  expect(context.priceMoves).toEqual([
    { name: "Qwen: Qwen3 14B", percent: 2.7916666666666665, cheaper: false, discountEnded: false },
  ]);
  // Nearly quadrupling is not "up 74%", whatever the ranking arithmetic says.
  expect(renderRecapLines(context)).toContain("📊 Qwen: Qwen3 14B · 3.8× more expensive");
});

test("a price only speaks for a model something other than a price list knows", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [
      { id: "obscure/model", name: "Obscure: Model", pricing: { prompt: "0.0000001" } },
      {
        id: "upstage/solar-pro4",
        name: "Upstage: Solar Pro 4",
        created: "2026-08-10T00:00:00.000Z",
        pricing: { prompt: "0.00000003" },
      },
    ],
  };
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example/leaderboard",
    raw: [],
    records: [{ id: "text:overall:solar-pro4-20260805", name: "solar-pro4-20260805", rank: 12 }],
  };
  saveCollection(db, board, [wire], "2026-09-08T09:00:00.000Z");
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records = [
    { id: "obscure/model", name: "Obscure: Model", pricing: { prompt: "0.0000009" } },
    {
      id: "upstage/solar-pro4",
      name: "Upstage: Solar Pro 4",
      created: "2026-08-10T00:00:00.000Z",
      pricing: { prompt: "0.00000009" },
    },
  ];
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");

  const context = recapContext(db, "2026-09-13T18:00:00.000Z");
  // The obscure row moved nine times as far and is nobody's news; the benchmarked one speaks, and
  // says why it went up.
  expect(context.priceMoves).toEqual([
    { name: "Upstage: Solar Pro 4", percent: 2, cheaper: false, discountEnded: true },
  ]);
  expect(renderRecapLines(context)).toContain("📊 Upstage: Solar Pro 4 · launch pricing ended · 3.0× more expensive");
});

test("a price that goes up and comes back down again is not a week's news", () => {
  const db = openDatabase(":memory:");
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example/leaderboard",
    raw: [],
    records: [{ id: "text:overall:qwen3-14b", name: "Qwen3 14B", rank: 40 }],
  };
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B", pricing: { prompt: "0.00000012" } }],
  };
  saveCollection(db, board, [wire], "2026-09-08T09:00:00.000Z");
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records = [{ id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B", pricing: { prompt: "0.0000002275" } }];
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");
  catalogue.records = [{ id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B", pricing: { prompt: "0.00000012" } }];
  saveCollection(db, catalogue, [wire], "2026-09-12T10:00:00.000Z");

  // The provider serving it changed and changed back. The week's net move is nothing.
  expect(recapContext(db, "2026-09-13T18:00:00.000Z").priceMoves).toEqual([]);
});

test("a reseller's catalogue speaks for makers this tracker follows", () => {
  const db = openDatabase(":memory:");
  const catalogue: Collection = {
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "openai/baseline", name: "OpenAI: Baseline" }],
  };
  saveCollection(db, catalogue, [wire], "2026-09-08T10:00:00.000Z");
  catalogue.records.push(
    { id: "sakana/fugu-max", name: "Sakana: Fugu Max" },
    // A 3B model that turns HTML into JSON: a real model, a developer's tool, and nothing any
    // benchmark, arena or maker's API we read has ever heard of.
    { id: "inference-net/schematron-v2-turbo", name: "Inference.net: Schematron V2 Turbo" },
  );
  saveCollection(db, catalogue, [wire], "2026-09-09T10:00:00.000Z");

  const context = recapContext(db, "2026-09-13T18:00:00.000Z");
  expect(context.arrivals).toEqual([{ vendor: "Sakana", names: ["Fugu Max"] }]);
  expect(context.arrivalCount).toBe(1);
});

test("the scouts get one morning message about what moved at the top of a board, and nothing else", () => {
  const db = openDatabase(":memory:");
  const scouts: Destination = { id: "scouts", platform: "discord", channelId: "2", signals: ["codename"] };
  const board: Collection = {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example",
    raw: [],
    trackChanges: true,
    records: [
      { id: "text:a", name: "claude-fable-5.1", category: "text/overall", rank: 1, score: 1500 },
      { id: "text:b", name: "gpt-6-astra", category: "text/overall", rank: 2, score: 1490 },
    ],
  };
  saveCollection(db, board, [], "2026-09-16T01:00:00.000Z");
  board.records = [
    { id: "text:a", name: "claude-fable-5.1", category: "text/overall", rank: 2, score: 1500 },
    { id: "text:b", name: "gpt-6-astra", category: "text/overall", rank: 1, score: 1560 },
  ];
  saveCollection(db, board, [], "2026-09-16T12:00:00.000Z");

  const now = Date.parse("2026-09-17T07:00:00.000Z");
  expect(lastRecapPeriod(now, "day")).toBe("2026-09-17T06:00:00.000Z");
  expect(scheduleRecaps(db, { destinations: [scouts] } as never, now)).toEqual(["day"]);
  prepareDeliveries(db, now);
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries").get()?.body ?? "";
  expect(body).toContain("Daily moves");
  expect(body).toContain("now leads text/overall");
  expect(body).not.toContain("<@&");
});

test("a price that went both ways inside the period is not reported as a move", () => {
  const db = openDatabase(":memory:");
  const row = (prompt: string): Collection => ({
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: [{ id: "z-ai/glm-5.3-flash", name: "Z.ai: GLM 5.3 Flash", pricing: { prompt, completion: "0.0000003" } }],
  });
  saveCollection(db, row("0.0000001"), [], "2026-09-16T05:00:00.000Z");
  saveCollection(db, row("0.00000009"), [], "2026-09-16T11:17:00.000Z");
  saveCollection(db, row("0.00000007"), [], "2026-09-16T23:08:00.000Z");
  saveCollection(db, row("0.00000009"), [], "2026-09-17T00:52:00.000Z");
  expect(recapContext(db, "2026-09-17T06:00:00.000Z", "day").priceMoves).toEqual([]);
});
