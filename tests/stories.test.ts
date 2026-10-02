import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { identityFor, identitySignatures, modelSignature, signaturesConflict } from "../src/events/identity.js";
import { vendorOf } from "../src/events/interpretation.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { rebuildStories } from "../src/stories.js";
import { listStories } from "../src/storiesView.js";
import { registered } from "./registered.js";

const collection = (source: string, stream: string, records: Collection["records"]): Collection =>
  registered({
    source,
    stream,
    url: "https://example.test",
    raw: records,
    records,
  });

/**
 * The contract of a source is declared by its registry entry, not derived from its id.
 *
 * `confidenceFor` and `evidenceTypeFor` used to answer this from a ladder of prefixes -- `github:`,
 * `npm:`, `huggingface:`, `cursor-changelog` -- so a source named outside the ladder was quietly
 * weaker than its twin inside it. These assertions are the same claims made against what the sources
 * say for themselves; `tests/sourceKinds.test.ts` holds the rule that every source says it.
 */
function contract(id: string): { evidence: string; confidence: string } {
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const found = buildSourceRegistry(openDatabase(":memory:"), config).find((source) => source.id === id);
  if (!found) throw new Error(`No such source: ${id}`);
  return { evidence: found.evidence, confidence: found.confidence };
}

test("what a source's evidence is worth is declared by the source, not read off its name", () => {
  expect(contract("arena")).toEqual({ evidence: "arena_roster", confidence: "observed" });
  expect(contract("openai")).toEqual({ evidence: "api_catalogue", confidence: "confirmed" });
  expect(contract("openai-news")).toEqual({ evidence: "official_news", confidence: "supported" });
  // A release is the artifact existing, which is `confirmed`; that the model is out is
  // `lifecycleState`, not a rung above confirmation. The other two reads of the same repository stay
  // at the floor, which the prefix ladder could not express: it matched the id, and all three share one.
  expect(contract("github:openai/codex:releases").confidence).toBe("confirmed");
  expect(contract("github:openai/codex:commits").confidence).toBe("observed");
  expect(contract("github:openai/codex:pulls").confidence).toBe("observed");
});

test("an aggregator republishing a catalogue is reporting it, not answering for it", () => {
  expect(contract("models-dev")).toEqual({ evidence: "availability_catalogue", confidence: "observed" });
  expect(contract("truefoundry-azure")).toEqual({ evidence: "availability_catalogue", confidence: "observed" });
  expect(contract("anthropic")).toEqual({ evidence: "api_catalogue", confidence: "confirmed" });
});

test("identity keeps Arena codenames unresolved until a canonical source identifies them", () => {
  const leaderboard = identityFor(
    { source: "arena-leaderboards", stream: "leaderboards", entity_id: "text:overall:secret-key" },
    { id: "text:overall:secret-key", name: "GPT-6 preview", modelKey: "secret-key" },
  );
  expect(leaderboard).toMatchObject({
    canonicalId: null,
    status: "codename",
    aliases: ["secret-key", "GPT-6 preview"],
  });

  const catalogue = identityFor(
    { source: "openrouter", stream: "openrouter", entity_id: "openai/gpt-6" },
    { id: "openai/gpt-6", name: "GPT-6" },
  );
  expect(catalogue).toMatchObject({ canonicalId: "openai/gpt-6", status: "canonical", aliases: ["GPT-6"] });
});

test("stories correlate evidence without rewriting the original events", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "gpt-5", name: "GPT-5", pricing: { prompt: "1" } }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "gpt-5", name: "GPT-5", pricing: { prompt: "2" } }]),
    [],
    "2026-09-08T00:05:00.000Z",
  );
  saveCollection(
    db,
    collection("openai", "api-models", [{ id: "gpt-5", name: "GPT-5", context: 100 }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    collection("openai", "api-models", [{ id: "gpt-5", name: "GPT-5", context: 200 }]),
    [],
    "2026-09-08T00:10:00.000Z",
  );
  const original = db.query("SELECT id,source,confidence FROM events ORDER BY id").all();
  const stories = listStories(db, { minConfidence: "confirmed", limit: 10 });
  expect(stories).toHaveLength(1);
  expect(stories[0]).toMatchObject({
    vendor: "OpenAI",
    canonicalId: "gpt-5",
    identityStatus: "canonical",
    confidence: "confirmed",
    currentStatus: "active",
    sources: ["openrouter", "openai"],
    eventIds: [1, 2],
  });
  expect(listStories(db, { minConfidence: "confirmed", limit: 10 })[0]?.id).toBe(stories[0]?.id);
  expect(db.query("SELECT id,source,confidence FROM events ORDER BY id").all()).toEqual(original);
  const writesBeforeRead = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes;
  listStories(db, { limit: 10 });
  const writesAfterRead = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes;
  expect(writesAfterRead).toBe(writesBeforeRead);
  db.close();
});

test("stories expose independent evidence coverage without rewriting event authority", () => {
  const db = openDatabase(":memory:");
  const router = collection("openrouter", "openrouter", [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro Release",
      maker: "DeepSeek",
      url: "https://example.test/deepseek-v4-pro?utm_source=router",
      pricing: { prompt: "1" },
    },
  ]);
  saveCollection(db, router, [], "2026-09-08T00:00:00.000Z");
  const routerRecord = router.records[0];
  if (!routerRecord) throw new Error("Missing router record");
  router.records[0] = { ...routerRecord, pricing: { prompt: "2" } };
  saveCollection(db, router, [], "2026-09-08T00:05:00.000Z");

  const official = collection("deepseek-updates", "news", [
    {
      id: "deepseek-v4-pro-update",
      name: "DeepSeek V4 Pro Update",
      url: "https://example.test/deepseek-v4-pro?utm_medium=news",
      maker: "DeepSeek",
      summary: "The official update is available.",
    },
  ]);
  saveCollection(db, official, [], "2026-09-08T00:06:00.000Z");
  const officialRecord = official.records[0];
  if (!officialRecord) throw new Error("Missing official record");
  official.records[0] = { ...officialRecord, summary: "The official update is generally available." };
  saveCollection(db, official, [], "2026-09-08T00:07:00.000Z");

  const story = listStories(db, { vendor: "DeepSeek", limit: 10 })[0];
  expect(story).toMatchObject({
    authorities: ["third_party", "first_party"],
    sourceFamilies: ["openrouter", "official-news:deepseek-updates"],
    evidenceCoverage: {
      eventCount: 2,
      sourceCount: 2,
      independentSourceCount: 2,
      corroborated: true,
    },
  });
  expect(story?.evidence.map((event) => event.authority)).toEqual(["third_party", "first_party"]);
  expect(db.query("SELECT authority FROM events ORDER BY id").all()).toEqual([
    { authority: "third_party" },
    { authority: "first_party" },
  ]);
  db.close();
});

test("a story merely touched in the window did not begin in it", () => {
  const db = openDatabase(":memory:");
  const source = collection("test", "api-models", [{ id: "gpt", name: "GPT", context: 1 }]);
  saveCollection(db, source, [], "2026-09-07T00:00:00.000Z");
  source.records = [{ id: "gpt", name: "GPT", context: 2 }];
  saveCollection(db, source, [], "2026-09-08T00:00:00.000Z");
  source.records = [{ id: "gpt", name: "GPT", context: 3 }];
  saveCollection(db, source, [], "2026-09-09T10:00:00.000Z");
  const window = "2026-09-09T00:00:00.000Z";
  // The catalogue re-read an old model, so the story was updated in the window and is not news in it.
  expect(listStories(db, { since: window, limit: 10 })).toHaveLength(1);
  expect(listStories(db, { since: window, startedSince: window, limit: 10 })).toHaveLength(0);
  expect(listStories(db, { startedSince: "2026-09-08T00:00:00.000Z", limit: 10 })).toHaveLength(1);
  db.close();
});

test("story time filters compare timestamps as instants", () => {
  const db = openDatabase(":memory:");
  const source = collection("test", "api-models", [{ id: "gpt", name: "GPT", context: 1 }]);
  saveCollection(db, source, [], "2026-09-08T00:00:00.000Z");
  source.records = [{ id: "gpt", name: "GPT", context: 2 }];
  saveCollection(db, source, [], "2026-09-08T10:00:00.000Z");
  expect(listStories(db, { since: "2026-09-08T11:00:00+02:00", limit: 10 })).toHaveLength(1);
  expect(listStories(db, { since: "2026-09-08T10:00:00.000Z", limit: 10 })).toHaveLength(1);
  db.close();
});

test("GitHub repository events stay separate unless their entity identity is the same", () => {
  const db = openDatabase(":memory:");
  const github = (source: string, records: Collection["records"]): Collection => ({
    ...collection(source, "github", records),
    appendOnly: true,
    trackChanges: true,
  });
  saveCollection(
    db,
    github("github:openai/codex:commits", [{ id: "sha-1", name: "Auth cleanup" }]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:pulls", [{ id: "42", name: "#42 Auth cleanup" }]),
    [],
    "2026-09-08T00:01:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:releases", [{ id: "100", name: "v0.50.0" }]),
    [],
    "2026-09-08T00:02:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:commits", [
      { id: "sha-1", name: "Auth cleanup" },
      { id: "sha-2", name: "Terminal changes" },
    ]),
    [],
    "2026-09-08T00:03:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:pulls", [
      { id: "42", name: "#42 Auth cleanup" },
      { id: "43", name: "#43 Windows support" },
    ]),
    [],
    "2026-09-08T00:04:00.000Z",
  );
  saveCollection(
    db,
    github("github:openai/codex:releases", [
      { id: "100", name: "v0.50.0" },
      { id: "101", name: "v0.51.0" },
    ]),
    [],
    "2026-09-08T00:05:00.000Z",
  );

  const stories = listStories(db, { vendor: "OpenAI", limit: 20 });
  expect(stories).toHaveLength(3);
  expect(stories.every((story) => story.eventIds.length === 1)).toBe(true);
  expect(stories.find((story) => story.sources[0]?.endsWith(":releases"))).toMatchObject({ confidence: "confirmed" });
  expect(
    stories.filter((story) => story.sources[0]?.endsWith(":commits")).every((story) => story.confidence === "observed"),
  ).toBe(true);
  db.close();
});

const designArena = (source: string, records: Collection["records"]): Collection => ({
  source,
  stream: "leaderboards",
  url: `https://www.designarena.ai/leaderboard/${source.split(":")[1]}`,
  raw: records,
  records,
});

test("a similar display name never merges two subjects one source family already told apart", () => {
  const db = openDatabase(":memory:");
  const websiteBaseline = [{ id: "website:1", name: "kimi-k3", category: "designarena/website", rank: 1 }];
  const uiBaseline = [{ id: "uicomponent:1", name: "kimi-k3", category: "designarena/uicomponent", rank: 1 }];
  saveCollection(db, designArena("designarena:website", websiteBaseline), [], "2026-09-08T00:00:00.000Z");
  saveCollection(db, designArena("designarena:uicomponent", uiBaseline), [], "2026-09-08T00:01:00.000Z");
  saveCollection(
    db,
    designArena("designarena:website", [
      ...websiteBaseline,
      { id: "website:2", name: "muse-spark-1.3", category: "designarena/website", rank: 2 },
    ]),
    [],
    "2026-09-08T00:05:00.000Z",
  );
  saveCollection(
    db,
    designArena("designarena:uicomponent", [
      ...uiBaseline,
      { id: "uicomponent:2", name: "muse-spark-1.3-max", category: "designarena/uicomponent", rank: 2 },
    ]),
    [],
    "2026-09-08T00:10:00.000Z",
  );

  const stories = listStories(db, { limit: 20 });
  expect(stories.find((story) => story.eventIds.length > 1)).toBeUndefined();
  expect(stories.map((story) => story.title).sort()).toEqual(["muse-spark-1.3", "muse-spark-1.3-max"]);
  db.close();
});

test("one subject still correlates across the categories of a single leaderboard family", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    designArena("designarena:website", [
      { id: "website:1", name: "kimi-k3", category: "designarena/website", rank: 4 },
    ]),
    [],
    "2026-09-08T00:00:00.000Z",
  );
  saveCollection(
    db,
    designArena("designarena:uicomponent", [
      { id: "uicomponent:1", name: "kimi-k3", category: "designarena/uicomponent", rank: 4 },
    ]),
    [],
    "2026-09-08T00:01:00.000Z",
  );
  saveCollection(
    db,
    designArena("designarena:website", [
      { id: "website:1", name: "kimi-k3", category: "designarena/website", rank: 2 },
    ]),
    [],
    "2026-09-08T00:05:00.000Z",
  );
  saveCollection(
    db,
    designArena("designarena:uicomponent", [
      { id: "uicomponent:1", name: "kimi-k3", category: "designarena/uicomponent", rank: 2 },
    ]),
    [],
    "2026-09-08T00:06:00.000Z",
  );

  const stories = listStories(db, { limit: 20 });
  expect(stories).toHaveLength(1);
  expect(stories[0]?.eventIds).toHaveLength(2);
  db.close();
});

test("one release reached by two routes is one story, not two", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, collection("arena", "arena", [{ id: "other", name: "other" }]), [], "2026-09-10T17:30:00.000Z");
  // Half an hour apart on the Arena, as Kimi K3 actually arrived.
  saveCollection(
    db,
    collection("arena", "arena", [
      { id: "other", name: "other" },
      { id: "kimi-k3-official", name: "kimi-k3-official" },
    ]),
    [],
    "2026-09-10T18:00:00.000Z",
  );
  saveCollection(
    db,
    collection("arena", "arena", [
      { id: "other", name: "other" },
      { id: "kimi-k3-official", name: "kimi-k3-official" },
      { id: "kimi-k3-gateway", name: "kimi-k3-gateway" },
    ]),
    [],
    "2026-09-10T18:26:00.000Z",
  );

  const stories = listStories(db, { limit: 10 });
  expect(stories).toHaveLength(1);
  expect(stories[0]?.eventIds).toHaveLength(2);
  db.close();
});

test("a dated alias of a model is the same model", () => {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    collection("openai", "api-models", [{ id: "gpt-5", name: "GPT-5" }]),
    [],
    "2026-09-09T16:00:00.000Z",
  );
  // OpenAI published both spellings in the same catalogue read.
  saveCollection(
    db,
    collection("openai", "api-models", [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-image-2.5-flare", name: "gpt-image-2.5-flare" },
      { id: "gpt-image-2.5-flare-2026-09-08", name: "gpt-image-2.5-flare-2026-09-08" },
    ]),
    [],
    "2026-09-09T17:07:00.000Z",
  );

  expect(listStories(db, { limit: 10 })).toHaveLength(1);
  db.close();
});

test("two tiers of one family stay two models", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, collection("arena", "arena", [{ id: "other", name: "other" }]), [], "2026-09-10T17:00:00.000Z");
  saveCollection(
    db,
    collection("arena", "arena", [
      { id: "other", name: "other" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      { id: "deepseek-v4-pro-max", name: "deepseek-v4-pro-max" },
    ]),
    [],
    "2026-09-10T17:55:00.000Z",
  );

  expect(listStories(db, { limit: 10 })).toHaveLength(2);
  db.close();
});

test("a Hugging Face derivative does not corroborate the model it was built from", () => {
  const db = openDatabase(":memory:");
  const at = "2026-09-12T09:00:00.000Z";
  saveCollection(
    db,
    {
      source: "openrouter",
      stream: "openrouter",
      url: "https://openrouter.ai/models",
      raw: [],
      records: [{ id: "qwen/qwen3-4b-instruct", name: "Qwen3 4B Instruct", maker: "Qwen" }],
    },
    [],
    at,
  );
  // A quantised finetune carries the base model's terms in its name and nothing of its news.
  saveCollection(
    db,
    {
      source: "discovery:huggingface-trending",
      stream: "weights",
      url: "https://huggingface.co/api/models",
      raw: [],
      appendOnly: true,
      records: [
        {
          id: "Ali-Mhrez/Qwen3-4B-Instruct-2507-SD-FNC-512-43",
          name: "Ali-Mhrez/Qwen3-4B-Instruct-2507-SD-FNC-512-43",
        },
      ],
    },
    [],
    at,
  );
  rebuildStories(db);

  const shared = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) c FROM (
         SELECT se.story_id FROM story_events se JOIN events e ON e.id=se.event_id
         GROUP BY se.story_id HAVING COUNT(DISTINCT e.source)>1)`,
    )
    .get();
  expect(shared?.c).toBe(0);
  db.close();
});

test("a vendor pattern claims its own models and nobody else's", () => {
  const vendor = (maker: string, entity = "x") =>
    vendorOf(
      { signal: null, source: "arena-leaderboards", entity_id: entity } as never,
      { id: entity, maker } as never,
    );

  // Named by the competitor audit and confirmed against a week of production events.
  expect(vendor("Tencent")).toBe("Tencent");
  expect(vendor("Bytedance")).toBe("ByteDance");
  expect(vendor("Black Forest Labs")).toBe("Black Forest Labs");
  expect(vendor("Microsoft AI")).toBe("Microsoft");
  // A maker recorded as exactly "Meta" reached Unknown while the pattern demanded a trailing slash.
  expect(vendor("Meta")).toBe("Meta");
  // SpaceXAI is not xAI, and a Hugging Face account called Xaiowu is neither.
  expect(vendor("SpaceXAI")).toBe("Unknown");
  expect(vendor("", "Xaiowu/shan-tts-mms-v2")).toBe("Unknown");
  expect(vendor("xAI")).toBe("xAI");
  expect(vendor("Xiaomi MiMo")).toBe("Xiaomi");
  expect(vendor("Poolside")).toBe("Poolside");
  // Stories for these three reached Unknown in the week of 2026-09-08.
  expect(vendor("", "muse-spark-1.2")).toBe("Meta");
  expect(vendor("", "internlm/Atria-Dawn-Preview-Ascend-w8a8")).toBe("Shanghai AI Lab");
  expect(vendor("prism-ml", "prism-ml/Ternary-Bonsai-2-27B-gguf-dev")).toBe("PrismML");
  expect(vendor("abacusai", "abacusai/Smaug-Mini")).toBe("Abacus.AI");
  // Somebody else's fine-tune of a PrismML model is not PrismML's news.
  expect(vendor("", "Continuum-AI-Corp/OrcaBonsai-27B-Uncensored")).toBe("Unknown");
  // A cloud that resells a model does not become its maker.
  expect(vendorOf({ signal: null, source: "aws-bedrock-lifecycle", entity_id: "claude-sonnet" } as never, null)).toBe(
    "Anthropic",
  );
  // Nor does a catalogue that writes its own name into the maker field: Alibaba Model Studio lists
  // Z.ai's GLM 5.3, and the recap of 2026-09-20 filed it under Qwen.
  expect(
    vendorOf(
      { signal: null, source: "dashscope", entity_id: "glm-5.3" } as never,
      {
        id: "glm-5.3",
        name: "glm-5.3",
        maker: "Alibaba Model Studio",
      } as never,
    ),
  ).toBe("Z.ai");
  // The same field still answers for a model whose own name says nothing.
  expect(
    vendorOf(
      { signal: null, source: "dashscope", entity_id: "qwen-max" } as never,
      {
        id: "qwen-max",
        name: "qwen-max",
        maker: "Alibaba Model Studio",
      } as never,
    ),
  ).toBe("Qwen");
});

test("a name's version and product line are read the way the makers write them", () => {
  expect(modelSignature("gemini-3.8-flash")).toEqual({ version: "3.8", lines: "flash" });
  expect(modelSignature("Google: Gemini 3.1 Flash Lite")).toEqual({ version: "3.1", lines: "flash lite" });
  expect(modelSignature("claude-opus-4-1-max")?.version).toBe("4.1");
  expect(modelSignature("claude-opus-4-20250514-thinking-16k")?.version).toBe("4");
  expect(modelSignature("deepseek-v4.1-flash-max-20260910")?.version).toBe("4.1");
  expect(modelSignature("Qwen3.8-Max")?.version).toBe("3.8");
  expect(modelSignature("qwen-image-3-0")).toEqual(modelSignature("Qwen-Image-3.0"));
  expect(modelSignature("qwen-image-edit-2511")).toEqual({ version: null, lines: "edit image" });
  expect(modelSignature("instant-ramen-a85d")).toBeNull();
  expect(modelSignature("01a0ad5f-8570-7d44-88e5-53e1c0826aaf")).toBeNull();

  const of = (...names: string[]) => names.map(modelSignature).filter((one) => one !== null);
  expect(signaturesConflict(of("gemini-3.8-flash"), of("gemini-3.1-flash-lite"))).toBe(true);
  expect(signaturesConflict(of("gemini-2.5-flash"), of("gemini-3-flash"))).toBe(true);
  expect(signaturesConflict(of("GPT-5.2 (xHigh)"), of("gpt-5.5-xhigh-webdev"))).toBe(true);
  expect(signaturesConflict(of("Z.ai: GLM 5.3 Flash"), of("glm-5.3-flash-webdev"))).toBe(false);
  expect(signaturesConflict(of("DeepSeek Pro Latest"), of("deepseek-v4-pro-0424-high"))).toBe(false);
  expect(signaturesConflict(of("Qwen-Image-3.0-Pro"), of())).toBe(false);
  expect(modelSignature("Nano Banana (Gemini 2.5 Flash Image)")).toEqual({ version: "2.5", lines: "flash image" });
  // Artificial Analysis keys the image model as plain Gemini 2.5 Flash; the record's name says otherwise.
  const imageRecord = identitySignatures({
    canonicalId: null,
    displayName: "Nano Banana (Gemini 2.5 Flash Image)",
    aliases: ["google_gemini-2-5-flash", "Nano Banana (Gemini 2.5 Flash Image)"],
    status: "codename",
  });
  expect(signaturesConflict(imageRecord, of("Google: Gemini 2.5 Flash", "google/gemini-2.5-flash"))).toBe(true);
  expect(signaturesConflict(imageRecord, of("google/gemini-2.5-flash-image"))).toBe(false);
  expect(signaturesConflict(of("Gemini 3 Pro Preview", "Gemini Pro Latest"), of("gemini-3.1-pro"))).toBe(true);
});

test("Gemini 3.8 Flash is not filed under Gemini 3.1 Flash Lite for sharing three title words", () => {
  const db = openDatabase(":memory:");
  // A source's first read is its baseline; what follows it is what the stories are made of.
  const baseline = { id: "baseline", name: "baseline" };
  for (const [source, stream] of [
    ["designarena:gamedev", "leaderboards"],
    ["arena-leaderboards", "leaderboards"],
    ["openrouter", "openrouter"],
    ["arena", "arena"],
  ] as const)
    saveCollection(db, collection(source, stream, [baseline]), [], "2026-09-08T00:00:00.000Z");
  saveCollection(
    db,
    collection("designarena:gamedev", "leaderboards", [
      baseline,
      { id: "gemini-3.8-flash", name: "gemini-3.8-flash", rank: 10 },
    ]),
    [],
    "2026-09-08T18:55:00.000Z",
  );
  saveCollection(
    db,
    collection("arena-leaderboards", "leaderboards", [
      baseline,
      {
        id: "text:overall:gemini-3.1-flash-lite-image",
        name: "gemini-3.1-flash-lite-image (nano-banana-2-lite)",
        modelKey: "instant-ramen-a85d",
        rank: 40,
      },
    ]),
    [],
    "2026-09-08T19:27:00.000Z",
  );
  saveCollection(
    db,
    collection("openrouter", "openrouter", [
      baseline,
      { id: "google/gemini-3.1-flash-lite", name: "Google: Gemini 3.1 Flash Lite" },
      { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash" },
      { id: "z-ai/glm-5.3-flash", name: "Z.ai: GLM 5.3 Flash" },
    ]),
    [],
    "2026-09-10T16:38:00.000Z",
  );
  saveCollection(
    db,
    collection("arena", "arena", [
      baseline,
      {
        id: "01a0ad5f-8570-7d44-88e5-53e1c0826aaf",
        model: "gemini-3.8-flash",
        name: "gemini-3.8-flash",
        maker: "google",
        selectable: true,
      },
      { id: "019e0000-0000-7000-8000-000000000000", model: "glm-5.3-flash", name: "glm-5.3-flash" },
    ]),
    [],
    "2026-09-17T03:23:00.000Z",
  );
  rebuildStories(db);

  const stories = listStories(db, { limit: 50 });
  const holding = (name: string) => stories.filter((story) => story.aliases.includes(name) || story.title === name);
  expect(holding("gemini-3.8-flash").length).toBeGreaterThan(0);
  for (const story of holding("gemini-3.8-flash")) {
    expect(story.aliases.join(" ")).not.toMatch(/3\.1|nano-banana/);
    expect(story.canonicalId === null || story.canonicalId.includes("3.8")).toBe(true);
  }
  // The same model under two catalogues still meets itself.
  const glm = holding("glm-5.3-flash");
  expect(glm).toHaveLength(1);
  expect(glm[0]?.sources.sort()).toEqual(["arena", "openrouter"]);
  db.close();
});

/** A source's first collection is its baseline, so a seed row goes in before the model does. */
const seeded = (db: Parameters<typeof saveCollection>[0], source: string, stream: string, at: string): void => {
  saveCollection(db, collection(source, stream, [{ id: `${source}/seed`, name: "Seed" }]), [], at);
};

test("a claim rises as sources agree, and the immutable events under it do not move", () => {
  const db = openDatabase(":memory:");
  const record = { id: "anthropic/nimbus-2", name: "Nimbus 2" };
  seeded(db, "openrouter", "openrouter", "2026-09-08T00:00:00.000Z");
  seeded(db, "models-dev", "api-models", "2026-09-08T00:00:10.000Z");
  seeded(db, "anthropic", "api-models", "2026-09-08T00:00:20.000Z");
  // Three catalogues in turn: two resellers, which are `observed`, and then a maker's own API,
  // which is `confirmed`. Every event is written once and none of them is ever rewritten.
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "openrouter/seed", name: "Seed" }, record]),
    [],
    "2026-09-08T00:01:00.000Z",
  );
  saveCollection(
    db,
    collection("models-dev", "api-models", [{ id: "models-dev/seed", name: "Seed" }, record]),
    [],
    "2026-09-08T00:02:00.000Z",
  );
  saveCollection(
    db,
    collection("anthropic", "api-models", [{ id: "anthropic/seed", name: "Seed" }, record]),
    [],
    "2026-09-08T00:03:00.000Z",
  );
  rebuildStories(db);

  const story = listStories(db, { limit: 20 }).find((one) => one.title === "Nimbus 2");
  const claims = new Map(story?.claims.map((claim) => [claim.claim, claim]));
  expect(claims.get("existence")).toMatchObject({
    confidence: "confirmed",
    firstAt: "2026-09-08T00:01:00.000Z",
    // The date a rise happened is the first event to reach the strength, not the last event in.
    raisedAt: "2026-09-08T00:03:00.000Z",
  });
  expect(claims.get("availability")?.confidence).toBe("confirmed");
  // Raising a claim starts its support afresh: the two weaker rows are under `story_events`, and
  // what holds the claim up at the strength it now has is the event that got it there.
  expect(claims.get("existence")?.supportedBy).toHaveLength(1);

  // The evidence itself is untouched: the two reseller rows are still `observed`, which is what
  // the cards they made said at the time, and only the claim above them moved.
  expect(story?.evidence.map((event) => event.confidence).sort()).toEqual(["confirmed", "observed", "observed"]);
  db.close();
});

test("a claim only rises, and a withdrawal is read from the story's status instead", () => {
  const db = openDatabase(":memory:");
  const record = { id: "acme/nimbus-3", name: "Nimbus 3" };
  seeded(db, "openrouter", "openrouter", "2026-09-08T00:00:00.000Z");
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "openrouter/seed", name: "Seed" }, record]),
    [],
    "2026-09-08T00:01:00.000Z",
  );
  // A record has to be missing twice before the store calls it gone: one absence is a partial read.
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "openrouter/seed", name: "Seed" }]),
    [],
    "2026-09-08T00:02:00.000Z",
  );
  saveCollection(
    db,
    collection("openrouter", "openrouter", [{ id: "openrouter/seed", name: "Seed" }]),
    [],
    "2026-09-08T00:03:00.000Z",
  );
  rebuildStories(db);

  const story = listStories(db, { limit: 20 }).find((one) => one.title === "Nimbus 3");
  const claims = new Map(story?.claims.map((claim) => [claim.claim, claim]));
  // A name leaving a catalogue is evidence it was there to be withdrawn, never evidence against it.
  expect(claims.get("existence")?.supportedBy).toHaveLength(2);
  expect(claims.get("availability")?.supportedBy).toHaveLength(1);
  expect(story?.currentStatus).toBe("removed");
  db.close();
});

test("a release date no calendar can hold is ignored instead of failing the whole projection", () => {
  const db = openDatabase(":memory:");
  const at = "2026-09-01T00:00:00.000Z";
  saveCollection(db, collection("openrouter", "openrouter", [{ id: "vendor/seed", name: "Seed" }]), [], at);
  // An epoch past the last instant a Date can represent: finite, later than 2015, and the story row
  // is written from it as an ISO string. One such field took `rebuildStories` down at boot.
  saveCollection(
    db,
    collection("openrouter", "openrouter", [
      { id: "vendor/seed", name: "Seed" },
      { id: "vendor/odd", name: "Odd", created: 1e17 },
    ]),
    [],
    "2026-09-02T00:00:00.000Z",
  );

  expect(() => rebuildStories(db)).not.toThrow();
  const story = db
    .query<{ released_at: string | null }, []>("SELECT released_at FROM stories WHERE normalized_subject LIKE '%odd%'")
    .get();
  expect(story?.released_at).toBeNull();
  db.close();
});
