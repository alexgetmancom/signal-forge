import { expect, test } from "bun:test";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import { renderRecapLines } from "../src/events/render/lifecycle.js";
import type { Collection } from "../src/events/types.js";
import { lastRecapPeriod, recapContext, recapContextSchema, scheduleRecaps } from "../src/recap.js";
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
  expect(renderRecapLines(context, ["launch"])).toContain("📊 Qwen3 14B · 3.8× more expensive");
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
  expect(renderRecapLines(context, ["launch"])).toContain(
    "📊 Solar Pro 4 · launch pricing ended · 3.0× more expensive",
  );
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
  expect(body).toContain("WHAT MOVED");
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

test("a day's prices go to the room that carries changes and its leaders to the room that carries sightings", () => {
  const day = recapContextSchema.parse({
    period: "day",
    from: "2026-09-16T06:00:00.000Z",
    to: "2026-09-17T06:00:00.000Z",
    arrivals: [],
    arrivalCount: 0,
    priceMoves: [{ name: "Z.ai: GLM 5.3 Flash", percent: 0.3, cheaper: true }],
    codenameCount: 0,
    leaders: [{ board: "text/overall", name: "GPT-6 Astra" }],
  });
  expect(renderRecapLines(day, ["launch", "change"]).join("\n")).toContain("📊 GLM 5.3 Flash · down 30%");
  expect(renderRecapLines(day, ["launch", "change"]).join("\n")).not.toContain("GPT-6 Astra");
  expect(renderRecapLines(day, ["codename"]).join("\n")).not.toContain("GLM");
  expect(renderRecapLines(day, ["launch"])).toEqual([]);
});

test("the wire gets one morning list of what the labs published, and the sightings stay with the scouts", () => {
  const db = openDatabase(":memory:");
  const site = (source: string, paths: string[]): Collection => ({
    source,
    stream: "pages",
    url: `https://${source}.example`,
    raw: [],
    records: paths.map((path) => ({
      id: path,
      name: `Vendor: ${path.split("/").at(-1)?.replaceAll("-", " ")}`,
      url: `https://${source}.example${path}`,
    })),
  });
  saveCollection(db, site("pages:mistral", ["/news/older"]), [], "2026-09-15T00:00:00.000Z");
  saveCollection(db, site("pages:claude-support", ["/en/articles/1-old"]), [], "2026-09-15T00:00:00.000Z");
  saveCollection(
    db,
    site("pages:mistral", ["/news/older", "/news/mistral-x-mozilla", "/models/mistral-large-4"]),
    [],
    "2026-09-16T12:00:00.000Z",
  );
  saveCollection(
    db,
    site("pages:claude-support", ["/en/articles/1-old", "/en/articles/2-set-up-salesforce"]),
    [],
    "2026-09-16T12:00:00.000Z",
  );

  const now = Date.parse("2026-09-17T07:00:00.000Z");
  expect(scheduleRecaps(db, config, now)).toEqual(["news"]);
  const context = recapContext(db, lastRecapPeriod(now, "news"), "news");
  // The partnership is the day's news; the model page is a sighting and the help article is neither.
  expect(context.headlines.map((line) => line.title)).toEqual(["mistral x mozilla"]);
  prepareDeliveries(db, now);
  const body = db.query<{ body: string }, []>("SELECT body FROM deliveries").get()?.body ?? "";
  expect(body).toContain("THE DAY IN AI");
  expect(body).toContain("https://pages:mistral.example/news/mistral-x-mozilla");
  expect(body).not.toContain("<@&");
  // A room that carries no launches does not get the list.
  expect(renderRecapLines(context, ["codename"])).toEqual([]);
});

test("the day's news reads in sections, one maker takes two lines of each, and business is left out", () => {
  const db = openDatabase(":memory:");
  const news = (source: string, titles: string[]): Collection => ({
    source,
    stream: "news",
    url: `https://${source}.example`,
    raw: [],
    records: titles.map((name, index) => ({
      id: `${source}-${index}`,
      name,
      url: `https://${source}.example/${index}`,
    })),
  });
  saveCollection(db, news("openai-news", ["An earlier post"]), [], "2026-09-15T00:00:00.000Z");
  saveCollection(db, news("hackernews", ["An earlier story"]), [], "2026-09-15T00:00:00.000Z");
  saveCollection(
    db,
    news("openai-news", [
      "An earlier post",
      "Operation “Trolling Stone”: Russia-linked influence activity",
      "Operation “Fish Food”: Russia-origin content farm activity",
      "Operation “No Bell”: Coordinated criticism of the US and allies",
      "On the Navier–Stokes Millennium Prize Problem",
      "1Password increases engineering productivity 21% with Codex",
      "Prompting fundamentals",
    ]),
    [],
    "2026-09-16T12:00:00.000Z",
  );
  saveCollection(
    db,
    news("hackernews", [
      "An earlier story",
      "ZCode, the GLM coding agent, silently uploads your Git history",
      "I hate you Microsoft",
    ]),
    [],
    "2026-09-16T12:00:00.000Z",
  );
  const context = recapContext(db, lastRecapPeriod(Date.parse("2026-09-17T07:00:00.000Z"), "news"), "news");
  const text = renderRecapLines(context, ["launch"]).join("\n");
  expect(text).toContain("🛡 **Safety**");
  expect(text).toContain("+1 more");
  expect(text).toContain("silently uploads your Git history");
  expect(text).toContain("🔬 **Research**");
  expect(text).toContain("Navier–Stokes");
  expect(text).toContain("📰 **Also from the labs**");
  expect(text).toContain("Prompting fundamentals");
  // A customer story is kept and never sent, and other people's opinions are not the labs' news.
  expect(text).not.toContain("1Password");
  expect(text).not.toContain("I hate you");
  expect(text.indexOf("Safety")).toBeLessThan(text.indexOf("Research"));
});

test("the scouts' morning names big climbs into the top ten and boards that opened", () => {
  const db = openDatabase(":memory:");
  const board = (rows: { id: string; category: string; rank: number }[]): Collection => ({
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.example",
    raw: [],
    records: rows.map((row) => ({ ...row, name: row.id })),
  });
  const text = Array.from({ length: 12 }, (_, index) => ({
    id: `m${index + 1}`,
    category: "text/overall",
    rank: index + 1,
  }));
  saveCollection(db, board(text), [], "2026-09-15T00:00:00.000Z");
  // m12 climbs to #4; a board nobody had seen opens with three rows.
  const moved = text.map((row) =>
    row.id === "m12" ? { ...row, rank: 4 } : row.rank >= 4 && row.rank < 12 ? { ...row, rank: row.rank + 1 } : row,
  );
  const opened = ["a", "b", "c"].map((id, index) => ({
    id: `itc-${id}`,
    category: "image-to-code/overall",
    rank: index + 1,
  }));
  saveCollection(db, board([...moved, ...opened]), [], "2026-09-16T12:00:00.000Z");
  const context = recapContext(db, lastRecapPeriod(Date.parse("2026-09-17T07:00:00.000Z"), "day"), "day");
  const lines = renderRecapLines(context, ["codename"]).join("\n");
  expect(lines).toContain("📈 m12 · #12 → #4 on Arena text");
  expect(lines).toContain("🆕 New board: Arena image-to-code · led by Itc A");
  // A one-place shuffle is churn.
  expect(lines).not.toContain("m5 ·");
  expect(renderRecapLines(context, ["launch"])).toEqual([]);
});
