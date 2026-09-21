import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { signalClass } from "../src/events/signals.js";
import { collectModelMentions, isTestFile, modelIdsInPatch, undated } from "../src/sources/modelMentions.js";
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
  expect(second.records.map((r) => r.id).sort()).toEqual(["@head", "gpt-5.6-luna", "gpt-6-luna"]);
  expect(second.silentIds?.sort()).toEqual(["@head", "gpt-5.6-luna"]);
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
