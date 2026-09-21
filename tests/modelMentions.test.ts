import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { pingWorthy, signalClass } from "../src/events/signals.js";
import { familyVersion, guessStage, judgeMentions, olderThanKnown } from "../src/sources/mentionStage.js";
import { collectModelMentions, isTestFile, modelIdsInPatch, undated } from "../src/sources/modelMentions.js";
import { collectRepoTalk } from "../src/sources/repoTalk.js";
import { openDatabase } from "../src/storage/database.js";

const config = {
  ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  GITHUB_TOKEN: "token",
};

test("model IDs are taken from added lines only, whole, and never from prose about a family", () => {
  const ids = modelIdsInPatch(
    [
      '-  "slug": "gpt-5.6-sol",',
      '+  "slug": "gpt-6-astra",',
      '+  cost: { "gpt-6-luna": 0.5 }, // served for gpt-5.6-luna.',
      "+Do not reuse GPT-6-specific defaults.",
      '+model = "claude-fable-5-1" or gemini-3.8-live-extended-thinking',
      "+ codex-rs/models and upgrading-to-gpt-6-astra.md",
    ].join("\n"),
  );
  expect([...ids.keys()].sort()).toEqual([
    "claude-fable-5-1",
    "gemini-3.8-live-extended-thinking",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-luna",
  ]);
  expect(ids.get("gpt-6-luna")).toContain("cost:");
});

test("a proxy's tests are recognised, and a dated snapshot is its undated model", () => {
  expect(isTestFile("packages/core/src/pricing.coldstart.test.ts")).toBe(true);
  expect(isTestFile("packages/http-api/src/handlers/__tests__/quota-drift-fixture.ts")).toBe(true);
  expect(isTestFile("codex-rs/tui/src/app/tests/daybreak_tests.rs")).toBe(true);
  expect(isTestFile("packages/core/src/pricing.ts")).toBe(false);
  expect(undated("gpt-5.4-mini-2026-03-17")).toBe("gpt-5.4-mini");
  expect(undated("claude-opus-5-20260101")).toBe("claude-opus-5");
  expect(undated("gpt-6-luna")).toBe("gpt-6-luna");
});

const sha = (n: number) => String(n).padStart(40, "0");
const commit = (n: number, message: string) => ({
  sha: sha(n),
  html_url: `https://github.com/d4rken/clankermux/commit/${sha(n)}`,
  commit: { message, author: { date: "2026-09-21T09:18:42Z" } },
});

test("the first read is a cursor; a later commit tells only the model nothing here has recorded", async () => {
  const db = openDatabase(":memory:");
  const watch = { repo: "d4rken/clankermux", authority: "third_party" as const };
  // A catalogue already lists gpt-5.6-luna, so seeing it in code is not news.
  saveCollection(
    db,
    {
      source: "openai",
      stream: "api-models",
      url: "https://x",
      raw: [],
      records: [{ id: "gpt-5.6-luna", name: "gpt-5.6-luna" }],
    },
    [],
  );
  let head = commit(1, "Initial");
  const request = async (url: string) => {
    if (url.includes("/commits?per_page=1")) return Response.json([head]);
    if (url.includes("/compare/")) return Response.json({ status: "ahead", commits: [head] });
    return Response.json({
      ...head,
      files: [
        {
          filename: "packages/core/src/pricing.ts",
          patch: '+\t"gpt-6-luna": { id: "gpt-6-luna" },\n+\t// answers some gpt-5.6-luna sends',
        },
        { filename: "packages/core/src/pricing.coldstart.test.ts", patch: '+\tmodel: "gpt-6-astra-reported",' },
      ],
    });
  };

  const first = await collectModelMentions(db, config, watch, request);
  expect(first.records.map((r) => r.id)).toEqual(["@head"]);
  saveCollection(db, first, []);

  head = commit(2, "fix(pricing): price gpt-6-luna and refresh the stale GPT-5.6 rates");
  const second = await collectModelMentions(db, config, watch, request);
  // gpt-5.6-luna is listed by a catalogue: not news, not stored, not judged.
  expect(second.records.map((r) => r.id).sort()).toEqual(["@head", "gpt-6-luna"]);
  expect(second.silentIds).toEqual(["@head"]);
  saveCollection(db, second, []);

  const events = db
    .query<{ entity_id: string; kind: string; source: string; stream: string; after_json: string }, []>(
      "SELECT * FROM events WHERE source='github:d4rken/clankermux:models'",
    )
    .all();
  expect(events.map((e) => `${e.kind} ${e.entity_id}`)).toEqual(["new gpt-6-luna"]);
  const after = JSON.parse(events[0]?.after_json ?? "{}");
  expect(after.url).toBe(`https://github.com/d4rken/clankermux/commit/${sha(2)}`);
  expect(after.file).toBe("packages/core/src/pricing.ts");
  expect(signalClass(events[0] as never)).toBe("codename");

  // Nothing moved: one request, nothing told, the cursor kept.
  const third = await collectModelMentions(db, config, watch, request);
  expect(third.records.map((r) => r.id)).toEqual(["@head"]);
  db.close();
});

type Row = { entity_id: string; kind: string; source: string; stream: string; after_json: string };
const eventsOf = (db: ReturnType<typeof openDatabase>, source: string) =>
  db.query<Row, [string]>("SELECT * FROM events WHERE source=? ORDER BY id").all(source);

/** A DeepSeek that answers with the given classes, and counts how often it was asked. */
function judge(stages: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    answer(body: string) {
      calls.push(body);
      return Response.json({ choices: [{ message: { content: JSON.stringify(stages) } }] });
    },
  };
}

test("without a judge, only words about a response make a sighting served", () => {
  expect(guessStage("fix: gpt-5.6-luna requests are being returned as gpt-6-luna")).toBe("served");
  expect(guessStage("I asked for gpt-5.6 and got gpt-6-luna back")).toBe("served");
  expect(guessStage("feat: add gpt-6-astra to the model list")).toBe("named");
});

test("a model named, then served, is told twice; only being served pings; another repo repeats nothing", async () => {
  const db = openDatabase(":memory:");
  const keyed = { ...config, DEEPSEEK_API_KEY: "key" };
  let stages = judge({ "gpt-7-nova": "named" });
  let head = commit(1, "Initial");
  const files = { current: [{ filename: "models.json", patch: '+  { "slug": "gpt-7-nova" }' }] };
  const request = async (url: string, init?: RequestInit) => {
    if (url.includes("deepseek")) return stages.answer(String(init?.body));
    if (url.includes("/commits?per_page=1")) return Response.json([head]);
    if (url.includes("/compare/")) return Response.json({ status: "ahead", commits: [head] });
    return Response.json({ ...head, files: files.current });
  };
  const codex = { repo: "openai/codex", vendor: "OpenAI", authority: "vendor_owned" as const };
  const proxy = { repo: "d4rken/clankermux", authority: "third_party" as const };
  for (const watch of [codex, proxy]) saveCollection(db, await collectModelMentions(db, keyed, watch, request), []);

  head = commit(2, "feat: list gpt-7-nova");
  saveCollection(db, await collectModelMentions(db, keyed, codex, request), []);
  const named = eventsOf(db, "github:openai/codex:models");
  expect(named.map((e) => e.entity_id)).toEqual(["gpt-7-nova"]);
  expect(signalClass(named[0] as never)).toBe("codename");
  expect(pingWorthy(named[0] as never)).toBe(false);

  // The proxy names it too: already told by codex, so it is kept without a word.
  saveCollection(db, await collectModelMentions(db, keyed, proxy, request), []);
  expect(eventsOf(db, "github:d4rken/clankermux:models")).toEqual([]);

  // Then the proxy has to price it because the backend returned it.
  head = commit(3, "fix(pricing): gpt-5.6-luna requests are being returned as gpt-7-nova");
  files.current = [{ filename: "src/pricing.ts", patch: '+  "gpt-7-nova": { input: 1 },' }];
  stages = judge({ "gpt-7-nova": "served" });
  saveCollection(db, await collectModelMentions(db, keyed, proxy, request), []);
  const served = eventsOf(db, "github:d4rken/clankermux:models");
  expect(served.map((e) => e.entity_id)).toEqual(["gpt-7-nova:served"]);
  expect(JSON.parse(served[0]?.after_json ?? "{}")).toMatchObject({ model: "gpt-7-nova", stage: "served" });
  expect(pingWorthy(served[0] as never)).toBe(true);
  expect(stages.calls[0]).toContain("returned as gpt-7-nova");
  db.close();
});

test("users reporting a model they were served are told; a model they merely name is kept", async () => {
  const db = openDatabase(":memory:");
  const keyed = { ...config, DEEPSEEK_API_KEY: "key" };
  const watch = { repo: "openai/codex", vendor: "OpenAI", authority: "vendor_owned" as const };
  const stages = judge({ "gpt-6-luna": "served", "gpt-7": "noise", "gpt-6-astra": "named" });
  const request = async (url: string, init?: RequestInit) => {
    if (url.includes("deepseek")) return stages.answer(String(init?.body));
    if (url.endsWith("/graphql"))
      return Response.json({
        data: {
          repository: {
            discussions: {
              nodes: [
                {
                  url: "https://github.com/openai/codex/discussions/9",
                  title: "When gpt-7?",
                  body: "Hoping for gpt-7 soon, gpt-6-astra is fine",
                  updatedAt: "2026-09-21T12:00:00Z",
                  author: { login: "fan" },
                  comments: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    if (url.includes("/issues/comments")) return Response.json([]);
    return Response.json([
      {
        html_url: "https://github.com/openai/codex/issues/1",
        title: "Response model is gpt-6-luna though I picked gpt-5.6-luna",
        body: "The usage panel shows gpt-6-luna for every turn since this morning.",
        updated_at: "2026-09-21T11:00:00Z",
        user: { login: "someone" },
      },
      {
        html_url: "https://github.com/openai/codex/pull/2",
        title: "gpt-6-luna pricing",
        updated_at: "2026-09-21T11:30:00Z",
        pull_request: {},
      },
    ]);
  };
  const first = await collectRepoTalk(db, keyed, watch, request, new Date("2026-09-21T10:00:00Z"));
  expect(first.records.map((r) => r.id)).toEqual(["@since"]);
  saveCollection(db, first, []);

  const second = await collectRepoTalk(db, keyed, watch, request);
  saveCollection(db, second, []);
  const told = eventsOf(db, "github:openai/codex:talk");
  expect(told.map((e) => e.entity_id)).toEqual(["gpt-6-luna:served"]);
  expect(JSON.parse(told[0]?.after_json ?? "{}")).toMatchObject({
    url: "https://github.com/openai/codex/issues/1",
    author: "someone",
  });
  expect(pingWorthy(told[0] as never)).toBe(true);
  expect(second.records.find((r) => r.id === "@since")).toMatchObject({ at: "2026-09-21T12:00:00Z" });
  expect(second.records.map((r) => r.id)).toContain("gpt-6-astra");
  db.close();
});

test("hyphen-joined prose is not a model", () => {
  expect([...modelIdsInPatch("+works for gpt-5.6-and-later, gpt-4-turbo-and-gpt-4 and gpt-5-vs-gpt-6").keys()]).toEqual(
    [],
  );
});

test("an old or misspelt model users say answered them is older than what is listed", () => {
  expect(familyVersion("gpt-5-6-thinking")).toEqual({ family: "gpt-", version: [5] });
  expect(familyVersion("claude-opus-5-1")).toEqual({ family: "claude-opus-", version: [5, 1] });
  expect(familyVersion("gemini-3.8-live")).toEqual({ family: "gemini-", version: [3, 8] });
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "openai",
      stream: "api-models",
      url: "https://x",
      raw: [],
      records: [
        { id: "gpt-6-astra", name: "gpt-6-astra" },
        { id: "openai/gpt-5.6-luna", name: "gpt-5.6-luna" },
      ],
    },
    [],
  );
  for (const id of ["gpt-5.3", "gpt-5-6-thinking", "gpt-5-mini-2025-08-07-batch", "gpt-5.5-codex"])
    expect(olderThanKnown(db, id)).toBe(true);
  for (const id of ["gpt-6-luna", "gpt-6-nova", "gpt-6.1", "gpt-7", "claude-opus-5", "gemini-4", "sora-3"])
    expect(olderThanKnown(db, id)).toBe(false);
  db.close();
});

test("without a judge, users' words never make a model served", async () => {
  const stages = await judgeMentions(
    config,
    fetch,
    "issue",
    "any gemini-4.2-flash is silently served by gemini-3.5-flash",
    ["gemini-4.2-flash"],
  );
  expect(stages.get("gemini-4.2-flash")).toBe("named");
  const commit = await judgeMentions(
    config,
    fetch,
    "commit",
    "the backend answers some gpt-5.6-luna sends with gpt-6-luna",
    ["gpt-6-luna"],
  );
  expect(commit.get("gpt-6-luna")).toBe("served");
});

test("a gateway is read only in its price table, never for an old model, and the judge's cost is kept", async () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "openai",
      stream: "api-models",
      url: "https://x",
      raw: [],
      records: [{ id: "gpt-6-astra", name: "gpt-6-astra" }],
    },
    [],
  );
  const keyed = { ...config, DEEPSEEK_API_KEY: "key" };
  const watch = {
    repo: "BerriAI/litellm",
    authority: "third_party" as const,
    paths: ["model_prices_and_context_window.json"],
  };
  let head = commit(1, "Initial");
  const request = async (url: string) => {
    if (url.includes("deepseek"))
      return Response.json({
        choices: [{ message: { content: '{"gpt-6-nova":"named"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
      });
    if (url.includes("/commits?per_page=1")) return Response.json([head]);
    if (url.includes("/compare/")) return Response.json({ status: "ahead", commits: [head] });
    return Response.json({
      ...head,
      files: [
        { filename: "model_prices_and_context_window.json", patch: '+  "gpt-6-nova": {},\n+  "gpt-5-image": {},' },
        { filename: "litellm/llms/huggingface/hf_text_generation_models.txt", patch: "+gpt-2-finetuned-code" },
      ],
    });
  };
  saveCollection(db, await collectModelMentions(db, keyed, watch, request), []);
  head = commit(2, "price sync");
  const second = await collectModelMentions(db, keyed, watch, request);
  expect(second.records.map((r) => r.id)).toEqual(["@head", "gpt-6-nova"]);
  const ledger = db
    .query<{ operation: string; source: string; outcome: string; cost_usd: number | null }, []>(
      "SELECT operation, source, outcome, cost_usd FROM deepseek_usage",
    )
    .all();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    operation: "mentions.judge",
    source: "github:BerriAI/litellm:models",
    outcome: "summarized",
  });
  expect(ledger[0]?.cost_usd).toBeGreaterThan(0);
  db.close();
});

test("open models are found by family and version", () => {
  const ids = modelIdsInPatch(
    '+ models: ["kimi-k3-thinking", "deepseek-v4-flash", "qwen3.6-max-preview", "minimax-m3", "mistral-large-3", "devstral-small-2"] // qwen-max, deepseek-chat',
  );
  expect([...ids.keys()]).toEqual([
    "kimi-k3-thinking",
    "deepseek-v4-flash",
    "qwen3.6-max-preview",
    "minimax-m3",
    "mistral-large-3",
    "devstral-small-2",
  ]);
  expect(familyVersion("kimi-k2.5")).toEqual({ family: "kimi-k", version: [2, 5] });
  expect(familyVersion("qwen3.6-max-preview")).toEqual({ family: "qwen", version: [3, 6] });
});

test("a checkpoint, a quantisation or a page's path is not a model", () => {
  const ids = modelIdsInPatch(
    '+ "qwen3-1p7b-fp8-draft", "qwen3-coder-30b-a3b-instruct-gguf", "deepseek-r1-0528-tput", "kimi-k3-us", "kimi-k2-5-now-in-microsoft-foundry", "kimi-k2-5-quickstart", "deepseek-v4.1-flash-beta", "gpt-6-astra-fast"',
  );
  expect([...ids.keys()]).toEqual(["deepseek-v4.1-flash-beta", "gpt-6-astra-fast"]);
});
