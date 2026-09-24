import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { classify } from "../src/events/classify.js";
import { identityFor, identityTerms, normalizeIdentity } from "../src/events/identity.js";
import { saveCollection } from "../src/events/pipeline.js";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import type { Fetch } from "../src/http-client.js";
import { withAudience } from "../src/sources/audienceJudge.js";
import { listedInCatalogue, olderThanKnown } from "../src/sources/mentionStage.js";
import { openDatabase } from "../src/storage/database.js";

const event = (over: Partial<Event> & { record: Record<string, unknown> }): Event => ({
  id: 1,
  source: "x",
  stream: "news",
  entity_id: String(over.record.id ?? "x"),
  kind: "new",
  before_json: null,
  after_json: JSON.stringify(over.record),
  detected_at: "2026-09-21T00:00:00.000Z",
  ...over,
});

test("a consumer ChatGPT feature is evidence; one about models still travels", () => {
  const notes = { source: "openai-chatgpt-release-notes", published: new Date().toISOString() };
  expect(
    signalClass(
      event({
        ...notes,
        record: {
          ...notes,
          id: "a",
          name: "Credit scores in Finances",
          summary: "Track your credit score in ChatGPT.",
        },
      }),
    ),
  ).toBe("evidence");
  expect(
    signalClass(
      event({
        ...notes,
        record: {
          ...notes,
          id: "c",
          name: "Privacy Center in ChatGPT",
          summary:
            "Brings together chat privacy, memory, personalization, data use, connected apps and account security.",
        },
      }),
    ),
  ).toBe("evidence");
  expect(
    signalClass(
      event({ ...notes, record: { ...notes, id: "b", name: "GPT-6 Astra in ChatGPT", summary: "Now available." } }),
    ),
  ).toBe("release");
});

test("catalogue lookups: a docs slug finds its launched model, an old model knows its successor", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "openrouter",
      stream: "openrouter",
      url: "https://x",
      raw: [],
      records: [
        { id: "x-ai/grok-4.7", name: "Grok 4.7" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet 4" },
        { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
      ],
    },
    [],
  );
  expect(listedInCatalogue(db, "grok-4-7")).toBe(true);
  expect(listedInCatalogue(db, "grok-4-8")).toBe(false);
  expect(olderThanKnown(db, "anthropic/claude-sonnet-4")).toBe(true);
  expect(olderThanKnown(db, "anthropic/claude-sonnet-4.6")).toBe(false);
  saveCollection(
    db,
    {
      source: "dashscope",
      stream: "api-models",
      url: "https://x",
      raw: [],
      records: [{ id: "glm-5.3", name: "GLM-5.3" }],
    },
    [],
  );
  const row = { source: "dashscope", stream: "api-models" };
  // A mode of a listed model is a trail; a mode whose base nobody sells is still the first word.
  expect(classify(db, event({ ...row, entity_id: "glm-5.3-prime", record: { id: "glm-5.3-prime" } }))).toBe("evidence");
  expect(classify(db, event({ ...row, entity_id: "glm-6-fast", record: { id: "glm-6-fast" } }))).toBe("codename");
  // A docs page for a model already on sale is late; one for a model nobody sells is a sighting.
  const page = { source: "pages:xai-docs", stream: "pages" };
  expect(
    classify(
      db,
      event({ ...page, entity_id: "/developers/grok-4-7", record: { id: "/developers/grok-4-7", name: "Grok 4 7" } }),
    ),
  ).toBe("evidence");
  expect(
    classify(
      db,
      event({ ...page, entity_id: "/developers/grok-4-8", record: { id: "/developers/grok-4-8", name: "Grok 4 8" } }),
    ),
  ).toBe("codename");
  // An old model's context moving is housekeeping; its price moving still travels.
  const or = { source: "openrouter", stream: "openrouter", kind: "changed" as const };
  const sonnet = { id: "anthropic/claude-sonnet-4", context_length: 200000, pricing: { prompt: 3 } };
  expect(
    classify(
      db,
      event({
        ...or,
        entity_id: sonnet.id,
        before_json: JSON.stringify({ ...sonnet, context_length: 1000000 }),
        record: sonnet,
      }),
    ),
  ).toBe("evidence");
  expect(
    classify(
      db,
      event({
        ...or,
        entity_id: sonnet.id,
        before_json: JSON.stringify({ ...sonnet, pricing: { prompt: 6 } }),
        record: sonnet,
      }),
    ),
  ).toBe("change");
  db.close();
});

test("a docs page joins its model's story by title without the site and by a versioned path", () => {
  const page = event({
    source: "pages:xai-docs",
    stream: "pages",
    entity_id: "/developers/grok-4-7",
    record: { id: "/developers/grok-4-7", name: "xAI Docs: Grok 4 7" },
  });
  const launch = event({ source: "xai", stream: "api-models", entity_id: "grok-4.7", record: { id: "grok-4.7" } });
  const terms = (e: Event) => identityTerms(identityFor(e, JSON.parse(e.after_json ?? "{}")));
  expect(terms(page)).toContain("grok 4 7");
  expect(terms(page).some((term) => terms(launch).includes(term))).toBe(true);
  // A blog path is not a model's name.
  const blog = event({
    source: "pages:google-devs",
    stream: "pages",
    entity_id: "/gemini-20-deep-dive-code-execution",
    record: { id: "/gemini-20-deep-dive-code-execution", name: "Google Developers: Deep dive" },
  });
  expect(terms(blog)).toEqual(["deep dive"]);
});

test("the audience judge's answer outranks the word list for ChatGPT notes", () => {
  const notes = { source: "openai-chatgpt-release-notes", stream: "news" };
  const note = (audience: string, name: string) =>
    signalClass(event({ ...notes, record: { ...notes, id: name, name, summary: "", audience } }));
  expect(note("consumers", "Connected apps for GPT-6 in Shopping")).toBe("evidence");
  expect(note("builders", "Scheduled tasks in ChatGPT")).toBe("release");
});

test("a stored ChatGPT note keeps its audience and is never judged again", async () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source: "s",
      stream: "news",
      url: "https://x",
      raw: [],
      records: [{ id: "old", name: "Old", audience: "consumers" }],
    },
    [],
  );
  const asked: string[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    asked.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ new: "builders" }) } }] }));
  }) as unknown as Fetch;
  const config = { DEEPSEEK_API_KEY: "k" } as AppConfig;
  const records = await withAudience(db, config, request, "s", [
    { id: "old", name: "Old" },
    { id: "new", name: "New" },
  ]);
  expect(records.map((record) => record.audience)).toEqual(["consumers", "builders"]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).not.toContain("ID: old");
});

test("a reseller moving only its cache or regional rates is evidence; input and output still travel", () => {
  const db = openDatabase(":memory:");
  const flash = { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" };
  const priced = (pricing: Record<string, unknown>) => ({ ...flash, pricing });
  const at = { source: "vercel-ai-gateway", stream: "api-models", kind: "changed" as const, entity_id: flash.id };
  const was = { input: "0.0000002", output: "0.0000008", input_cache_read: "0.00000003", regional: { us: 1 } };
  const side = { ...was, input_cache_read: "0.000000007", regional: { us: 2 } };
  expect(classify(db, event({ ...at, before_json: JSON.stringify(priced(was)), record: priced(side) }))).toBe(
    "evidence",
  );
  const cheaper = { ...side, output: "0.0000004" };
  expect(classify(db, event({ ...at, before_json: JSON.stringify(priced(was)), record: priced(cheaper) }))).toBe(
    "change",
  );
  // OpenRouter is the catalogue people price by: its cache moving still reaches the public channel.
  const or = { ...at, source: "openrouter", stream: "openrouter" };
  expect(classify(db, event({ ...or, before_json: JSON.stringify(priced(was)), record: priced(side) }))).toBe("change");
});

test("a version with its dot dropped is the same model as the version with it", () => {
  // models.dev writes `gpt-56-sol`, and holding that apart from `gpt-5.6-sol` put fourteen phantom
  // models in the catalogue, sent one to a reader as `glm-53-fast`, and had the probes hunting for
  // a `gpt-57` to follow version 56.
  expect(normalizeIdentity("gpt-56-sol")).toBe(normalizeIdentity("gpt-5.6-sol"));
  expect(normalizeIdentity("glm-53-fast")).toBe(normalizeIdentity("glm-5.3-fast"));
  expect(normalizeIdentity("claude-opus-55")).toBe(normalizeIdentity("claude-opus-5.5"));
  // A Google docs path writes the version the same way.
  expect(normalizeIdentity("gemini-15")).toBe(normalizeIdentity("gemini-1.5"));
  // A number that could be a real version is left alone: grok-4.20's twenty is a minor version,
  // and a parameter count is not a version at all.
  expect(normalizeIdentity("grok-4.20-beta")).toBe("grok 4 20 beta");
  expect(normalizeIdentity("qwen3-14b")).toBe("qwen3 14b");
  expect(normalizeIdentity("nemotron-3-super-120b-a12b")).toBe("nemotron 3 super 120b a12b");
});
