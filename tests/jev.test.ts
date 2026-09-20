import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { isNewsworthyStory, isNotableCommit, notableCommits, prepareInsights } from "../src/insights.js";
import { jevCallsToday, judgeEvents, judgementOf, PROMPT_VERSION, worthCutoff } from "../src/jev.js";
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

test("the cutoff admits the share it was asked for, whatever the scale is", () => {
  // The whole point: version 2 moved every score down by a third of a point and the fixed 1.6 went
  // from admitting 61 commits to admitting 4, though their order had not changed at all.
  const db = openDatabase(":memory:");
  // Three hundred judgements need three hundred events to point at, and none of this reads one.
  db.exec("PRAGMA foreign_keys=OFF");
  const insert = db.query(
    `INSERT INTO event_evaluations(event_id,evaluator,model,prompt_version,kind,worth,codename,confidence,rules,evaluated_at)
     VALUES(?,'jev','jev-latest',?,'feature',?,0,null,'evidence','2026-09-19T00:00:00.000Z')`,
  );
  const now = new Date("2026-09-20T00:00:00Z");
  // Too thin to have a distribution: the caller's own number stands.
  for (let i = 0; i < 199; i += 1) insert.run(i, PROMPT_VERSION, (i % 300) / 100);
  expect(worthCutoff(db, 0.22, 1.6, now)).toBe(1.6);

  // Three hundred scores spread evenly over 0 to 3, then the same spread squeezed into 0 to 1.5.
  db.query("DELETE FROM event_evaluations").run();
  for (let i = 0; i < 300; i += 1) insert.run(i, PROMPT_VERSION, i / 100);
  const wide = worthCutoff(db, 0.22, 1.6, now);
  db.query("DELETE FROM event_evaluations").run();
  for (let i = 0; i < 300; i += 1) insert.run(i, PROMPT_VERSION, i / 200);
  const narrow = worthCutoff(db, 0.22, 1.6, now);
  expect(wide).toBeCloseTo(2.34, 2);
  expect(narrow).toBeCloseTo(1.17, 2);
  // Different numbers, same share of the material: 66 of 300 sit above each.
  const above = (cutoff: number, scale: number) => [...Array(300).keys()].filter((i) => i / scale >= cutoff).length;
  expect(above(wide, 100)).toBe(above(narrow, 200));

  // A judgement at another prompt version is on another scale and is not counted.
  db.query("DELETE FROM event_evaluations").run();
  for (let i = 0; i < 300; i += 1) insert.run(i, "0", i / 100);
  expect(worthCutoff(db, 0.22, 1.6, now)).toBe(1.6);
  db.close();
});

test("one unanswered event does not end the pass, three in a row do", async () => {
  // A catch-up over 795 events stopped on its first, judged none, and reported no error of its own.
  const db = openDatabase(":memory:");
  const now = new Date("2026-09-19T08:00:00Z");
  commits(
    db,
    Array.from({ length: 8 }, (_, i) => `Add model ${i}`),
    new Date(now.getTime() - 3_600_000),
  );
  let asked = 0;
  const answer = () =>
    Response.json({ answers: { kind: { choice: "feature" }, worth: { score: 1 }, codename: { noul: 0.1 } } });
  const flaky = async () => {
    asked += 1;
    // The second request fails alone; the fifth begins a run of three.
    if (asked === 2 || asked >= 5) throw new Error("socket hang up");
    return answer();
  };
  expect(await judgeEvents(db, config, flaky as never, now)).toBe(3);
  // Asked eight times: one blip was stepped over, and the run of three ended it before the rest.
  expect(asked).toBe(7);
  db.close();
});

test("a post carries how old it already was when we found it", async () => {
  // Jev read a title and nothing else, and rated an eight-week-old announcement above the morning's.
  const db = openDatabase(":memory:");
  const now = new Date("2026-09-17T08:00:00Z");
  const base = { source: "anthropic:news", stream: "news" as const, url: "https://x.test", raw: {} };
  saveCollection(db, { ...base, records: [{ id: "seed", name: "seed" }] }, [], "2026-09-17T07:00:00.000Z");
  saveCollection(
    db,
    {
      ...base,
      records: [
        { id: "seed", name: "seed" },
        { id: "opus-5", name: "Introducing Claude Opus 5", published: "2026-07-24T00:00:00.000Z" },
        { id: "today", name: "Something announced this morning", published: "2026-09-17T06:00:00.000Z" },
      ],
    },
    [],
    "2026-09-17T07:30:00.000Z",
  );
  const states: Record<string, unknown>[] = [];
  const request = async (_url: string, init?: RequestInit) => {
    states.push((JSON.parse(String(init?.body)) as { state: Record<string, unknown> }).state);
    return Response.json({ answers: { kind: { choice: "new_model" }, worth: { score: 2 }, codename: { noul: 0.1 } } });
  };
  await judgeEvents(db, config, request as never, now);
  const stale = states.find((state) => state.id === "opus-5");
  expect(stale).toMatchObject({ days_old_when_found: 55, seen_at: "2026-09-17T07:30:00.000Z" });
  // Found within hours of being posted: there is no age to report, and none is invented.
  expect(states.find((state) => state.id === "today")).not.toHaveProperty("days_old_when_found");
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
  expect(result).toEqual({ judged: 0, commits: 0, findings: 0, lead: false, audited: false });
});

test("a day of leaderboard churn does not hide the events worth judging", async () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-09-19T08:00:00Z");
  commits(db, ["Add x"], new Date(now.getTime() - 7_200_000));
  const board = { source: "lb", stream: "leaderboards" as const, url: "https://x.test", raw: {} };
  const rows = (score: number) =>
    Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, score: score + i }));
  saveCollection(db, { ...board, records: rows(0) }, [], new Date(now.getTime() - 3_700_000).toISOString());
  saveCollection(db, { ...board, records: rows(1) }, [], new Date(now.getTime() - 3_600_000).toISOString());
  const request = async () =>
    Response.json({
      answers: { kind: { choice: "internal" }, worth: { score: 0.2 }, codename: { noul: 0.01 } },
    });
  expect(await judgeEvents(db, config, request as unknown as typeof fetch, now)).toBe(1);
});
