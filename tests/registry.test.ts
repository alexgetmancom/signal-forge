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
      ["modelscope.cn", 60],
      ["designarena.ai", 60],
    ]),
  );
  db.close();
});

test("conditional sources are disabled without credentials and enabled with them", () => {
  const disabledDb = openDatabase(":memory:");
  const disabled = buildSourceRegistry(disabledDb, config());
  expect(disabled.find((definition) => definition.id === "openai")?.enabled).toBe(false);
  expect(sourceJobs(disabledDb, config()).some((job) => job.id === "openai")).toBe(false);
  disabledDb.close();

  const enabledDb = openDatabase(":memory:");
  const enabledConfig = config({ OPENAI_API_KEY: "test-key" });
  expect(buildSourceRegistry(enabledDb, enabledConfig).find((definition) => definition.id === "openai")?.enabled).toBe(
    true,
  );
  expect(sourceJobs(enabledDb, enabledConfig).some((job) => job.id === "openai")).toBe(true);
  enabledDb.close();
});

test("registry rejects duplicate IDs and conflicting pacing", () => {
  const definition = {
    id: "source",
    label: "Source",
    group: "Group",
    stream: "news" as const,
    intervalSeconds: 60,
    collector: async () => ({
      source: "source",
      stream: "news" as const,
      url: "https://example.test",
      raw: [],
      records: [],
    }),
    enabled: true,
  };
  expect(() => validateSourceRegistry([definition, { ...definition }])).toThrow("Duplicate source ID");
  expect(() =>
    validateSourceRegistry([
      { ...definition, pace: { group: "host", seconds: 30 } },
      { ...definition, id: "other", pace: { group: "host", seconds: 60 } },
    ]),
  ).toThrow("conflicting intervals");
});

test("source labels cover generated families", () => {
  expect(sourceLabel("huggingface:openai")).toBe("Hugging Face · openai");
  expect(sourceLabel("github:openai/codex:releases")).toBe("GitHub · openai/codex · releases");
  expect(sourceLabel("unknown-source")).toBe("unknown-source");
});
