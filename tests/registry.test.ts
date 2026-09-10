import { expect, test } from "bun:test";
import { loadConfig, streamSchema } from "../src/config.js";
import { sourceLabel } from "../src/sources/labels.js";
import { buildSourceRegistry, sourceJobs, validateSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

function config(env: Record<string, string> = {}) {
  return loadConfig({ CONFIG_PATH: configPath, ...env });
}

test("source registry has unique IDs, valid streams, labels and consistent pacing", () => {
  const db = openDatabase(":memory:");
  const definitions = buildSourceRegistry(db, config());
  expect(new Set(definitions.map((definition) => definition.id)).size).toBe(definitions.length);
  expect(definitions.every((definition) => definition.label.trim().length > 0)).toBe(true);
  expect(definitions.every((definition) => streamSchema.safeParse(definition.stream).success)).toBe(true);
  expect(
    definitions.every((definition) => ["first_party", "vendor_owned", "third_party"].includes(definition.authority)),
  ).toBe(true);
  expect(definitions.find((definition) => definition.id === "openai")?.authority).toBe("first_party");
  expect(definitions.find((definition) => definition.id === "openrouter")?.authority).toBe("third_party");
  expect(definitions.find((definition) => definition.id === "vercel-gateway")?.restrictedReason).toBeUndefined();
  for (const id of [
    "openai-chatgpt-release-notes",
    "openai-codex-changelog",
    "openai-api-changelog",
    "gemini-api-changelog",
    "xai-release-notes",
    "mistral-release-notes",
    "groq-changelog",
  ]) {
    expect(definitions.find((definition) => definition.id === id)).toMatchObject({
      authority: "first_party",
      stream: "news",
      enabled: true,
    });
  }
  for (const id of [
    "google-ai-feed",
    "microsoft-ai-feed",
    "nvidia-ai-feed",
    "google-deepmind-feed",
    "codex-skills",
    "deepseek-news",
    "aider-polyglot",
  ]) {
    expect(definitions.find((definition) => definition.id === id)).toBeUndefined();
  }
  expect(definitions.some((definition) => definition.id === "openai-developer-feed")).toBe(false);
  expect(definitions.some((definition) => definition.id.startsWith("github:deepseek-ai/"))).toBe(false);
  expect(definitions.some((definition) => definition.id.startsWith("modelscope:"))).toBe(false);
  expect(
    definitions.filter((definition) => definition.id.startsWith("designarena:")).map((definition) => definition.id),
  ).toEqual(["designarena:website", "designarena:uicomponent", "designarena:image"]);

  const paceGroups = new Map<string, number>();
  for (const definition of definitions) {
    if (!definition.pace) continue;
    const existing = paceGroups.get(definition.pace.group);
    if (existing !== undefined) expect(definition.pace.seconds).toBe(existing);
    paceGroups.set(definition.pace.group, definition.pace.seconds);
  }
  expect(paceGroups).toEqual(
    new Map([
      ["huggingface.co", 60],
      ["designarena.ai", 60],
      ["github-search", 60],
    ]),
  );
  db.close();
});

test("reader-facing sources stay active while noisy repository activity and discovery start in shadow mode", () => {
  const db = openDatabase(":memory:");
  const defaults = buildSourceRegistry(db, config());
  expect(defaults.find((definition) => definition.id === "openrouter")).toMatchObject({ mode: "active" });
  expect(
    defaults
      .filter((definition) => definition.id.startsWith("discovery:github-"))
      .every((definition) => definition.mode === "shadow"),
  ).toBe(true);
  expect(defaults.find((definition) => definition.id === "discovery:huggingface-recent")?.mode).toBe("shadow");
  expect(defaults.find((definition) => definition.id === "github:openai/codex:pulls")?.mode).toBe("shadow");
  expect(defaults.find((definition) => definition.id === "github:openai/codex:commits")?.mode).toBe("shadow");
  expect(defaults.find((definition) => definition.id === "github:openai/codex:releases")?.mode).toBe("active");

  const overridden = buildSourceRegistry(db, {
    ...config(),
    sourceMode: { openrouter: "shadow", "discovery:github-ai": "active" },
  });
  expect(overridden.find((definition) => definition.id === "openrouter")?.mode).toBe("shadow");
  expect(overridden.find((definition) => definition.id === "discovery:github-ai")?.mode).toBe("active");
  db.close();
});

test("conditional sources distinguish intentional disablement from missing credentials", () => {
  const disabledDb = openDatabase(":memory:");
  const disabledConfig = config();
  disabledConfig.sourceEnabled.openai = false;
  const disabled = buildSourceRegistry(disabledDb, disabledConfig);
  expect(disabled.find((definition) => definition.id === "openai")?.enabled).toBe(false);
  expect(sourceJobs(disabledDb, disabledConfig).some((job) => job.id === "openai")).toBe(false);
  disabledDb.close();

  const missingDb = openDatabase(":memory:");
  const missingConfig = config();
  expect(buildSourceRegistry(missingDb, missingConfig).find((definition) => definition.id === "openai")?.enabled).toBe(
    true,
  );
  expect(sourceJobs(missingDb, missingConfig).some((job) => job.id === "openai")).toBe(false);
  missingDb.close();

  const readyDb = openDatabase(":memory:");
  const readyConfig = config({ OPENAI_API_KEY: "test-key" });
  expect(sourceJobs(readyDb, readyConfig).some((job) => job.id === "openai")).toBe(true);
  readyDb.close();

  const deepSeekDb = openDatabase(":memory:");
  const deepSeekConfig = config({ DEEPSEEK_API_KEY: "test-key" });
  expect(sourceJobs(deepSeekDb, deepSeekConfig).some((job) => job.id === "deepseek-api")).toBe(true);
  deepSeekDb.close();
});

test("registry rejects duplicate IDs and conflicting pacing", () => {
  const definition = {
    id: "source",
    label: "Source",
    group: "Group",
    stream: "news" as const,
    authority: "third_party" as const,
    intervalSeconds: 60,
    collector: async () => ({
      source: "source",
      stream: "news" as const,
      url: "https://example.test",
      raw: [],
      records: [],
    }),
    enabled: true,
    mode: "active" as const,
  };
  expect(() => validateSourceRegistry([definition, { ...definition }])).toThrow("Duplicate source ID");
  expect(() =>
    validateSourceRegistry([
      { ...definition, pace: { group: "host", seconds: 30 } },
      { ...definition, id: "other", pace: { group: "host", seconds: 60 } },
    ]),
  ).toThrow("conflicting intervals");
  expect(() => validateSourceRegistry([{ ...definition, mode: "invalid" as "active" }])).toThrow("invalid mode");
});

test("source labels cover generated families", () => {
  expect(sourceLabel("huggingface:openai")).toBe("Hugging Face · openai");
  expect(sourceLabel("github:openai/codex:releases")).toBe("GitHub · openai/codex · releases");
  expect(sourceLabel("deepseek-updates")).toBe("DeepSeek · updates");
  expect(sourceLabel("openai-chatgpt-release-notes")).toBe("OpenAI · ChatGPT release notes");
  expect(sourceLabel("openai-codex-changelog")).toBe("OpenAI · Codex changelog");
  expect(sourceLabel("openai-api-changelog")).toBe("OpenAI · API changelog");
  expect(sourceLabel("unknown-source")).toBe("unknown-source");
});
