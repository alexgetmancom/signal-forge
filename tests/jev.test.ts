import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { isNewsworthyStory, isNotableCommit, notableCommits, prepareInsights } from "../src/insights.js";
import { jevCallsToday, judgementOf } from "../src/jev.js";
import { openDatabase } from "../src/storage/database.js";

const fixture = new URL("./fixtures/config.json", import.meta.url).pathname;
const config = { ...loadConfig({ CONFIG_PATH: fixture }), DEEPSEEK_API_KEY: "ds", TYPESAFE_API_KEY: "jev" };

function commits(db: ReturnType<typeof openDatabase>, names: string[], at: Date) {
  const base = { source: "github:openai/codex:commits", stream: "github" as const, url: "https://x.test", raw: {} };
  saveCollection(
    db,
    { ...base, records: [{ id: "seed", name: "seed" }] },
    [],
    new Date(at.getTime() - 60_000).toISOString(),
  );
  saveCollection(
    db,
    { ...base, records: [{ id: "seed", name: "seed" }, ...names.map((name) => ({ id: name, name }))] },
    [],
    at.toISOString(),
  );
}

test("notability needs a model or feature Jev scores clearly, or a likely codename", () => {
  const j = { kind: "feature" as const, worth: 2, codename: 0.1, confidence: 0.9, rules: "evidence", at: "" };
  expect(isNotableCommit(j)).toBe(true);
  expect(isNotableCommit({ ...j, kind: "internal" })).toBe(false);
  expect(isNotableCommit({ ...j, kind: "internal", codename: 0.7 })).toBe(true);
  expect(isNotableCommit(null)).toBe(false);
  expect(isNewsworthyStory({ ...j, kind: "business", worth: 3 })).toBe(false);
  expect(isNewsworthyStory({ ...j, kind: "safety", worth: 2.2 })).toBe(true);
});

test("commits are judged, and only the notable one gets a DeepSeek line", async () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-09-19T08:00:00Z");
  commits(db, ["Add gpt-6-astra model preset", "Refactor prompt crate"], new Date(now.getTime() - 3_600_000));
  const asked: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (url.includes("typesafe")) {
      const feature = body.includes("astra");
      return Response.json({
        answers: {
          kind: { choice: feature ? "new_model" : "internal", confidence: 0.9 },
          worth: { score: feature ? 2.5 : 0.3 },
          codename: { noul: feature ? 0.8 : 0.05 },
        },
        usage: { input_tokens: 500, output_tokens: 3 },
      });
    }
    asked.push(body);
    return Response.json({ choices: [{ message: { content: "Prepares a gpt-6-astra model preset for Codex." } }] });
  };
  const result = await prepareInsights(db, config, request as unknown as typeof fetch, now);
  expect(result.judged).toBeGreaterThanOrEqual(2);
  expect(result.commits).toBe(1);
  expect(asked).toHaveLength(1);
  expect(jevCallsToday(db, now)).toBe(result.judged);
  const notable = notableCommits(db, "2026-09-18T00:00:00Z", now.toISOString());
  expect(notable.map((entry) => entry.event.entity_id)).toEqual(["Add gpt-6-astra model preset"]);
  expect(judgementOf(db, notable[0]?.event.id ?? 0)?.rules).toBeString();
  // A second pass asks nobody again.
  const again = await prepareInsights(db, config, request as unknown as typeof fetch, now);
  expect(again.judged).toBe(0);
  expect(asked).toHaveLength(1);
});

test("without a key nothing is asked", async () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-09-19T08:00:00Z");
  commits(db, ["Add x"], new Date(now.getTime() - 3_600_000));
  const request = async () => {
    throw new Error("called");
  };
  const result = await prepareInsights(
    db,
    { ...config, TYPESAFE_API_KEY: undefined, DEEPSEEK_API_KEY: undefined },
    request as unknown as typeof fetch,
    now,
  );
  expect(result).toEqual({ judged: 0, commits: 0, findings: 0 });
});
