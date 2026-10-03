import { expect, test } from "bun:test";
import { collectOpenRouterUsage, parseOpenRouterUsage } from "../src/sources/usage.js";

const day = (slug: string, date: string, prompt: number, completion: number) => ({
  date,
  model_permaslug: slug,
  variant: "standard",
  total_prompt_tokens: prompt,
  total_completion_tokens: completion,
  count: 10,
});

test("usage is read per model and ranked by the tokens people actually spent", () => {
  const rows = [
    day("deepseek/deepseek-v4-flash-20260731", "2026-09-12 00:00:00", 100, 10),
    day("deepseek/deepseek-v4-flash-20260731", "2026-09-13 00:00:00", 100, 10),
    day("openai/gpt-5.6-luna-20260709", "2026-09-13 00:00:00", 150, 5),
    ...Array.from({ length: 10 }, (_, index) => day(`vendor/model-${index}`, "2026-09-13 00:00:00", index, 0)),
  ];
  const collection = parseOpenRouterUsage(JSON.stringify({ data: rows }));
  expect(collection.source).toBe("openrouter-usage");
  expect(collection.records.slice(0, 2)).toEqual([
    {
      id: "deepseek/deepseek-v4-flash-20260731",
      name: "deepseek/deepseek-v4-flash-20260731",
      category: "OpenRouter usage",
      rank: 1,
      tokens: 220,
      requests: 20,
      url: "https://openrouter.ai/rankings",
    },
    {
      id: "openai/gpt-5.6-luna-20260709",
      name: "openai/gpt-5.6-luna-20260709",
      category: "OpenRouter usage",
      rank: 2,
      tokens: 155,
      requests: 10,
      url: "https://openrouter.ai/rankings",
    },
  ]);
});

test("a ranking that comes back nearly empty is a broken read, not a quiet week", () => {
  expect(() =>
    parseOpenRouterUsage(JSON.stringify({ data: [day("vendor/model", "2026-09-13 00:00:00", 1, 1)] })),
  ).toThrow("OpenRouter rankings no longer expose per-model usage");
});

test("the collector asks the site's weekly JSON API and keeps models beyond the HTML's twenty", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => day(`vendor/model-${index}`, "2026-10-03", index, 1));
  const collection = await collectOpenRouterUsage(async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/frontend/v1/rankings/models?view=week");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    return Response.json({ data: [...rows, day("", "2026-10-03", 1_000_000, 0)] });
  });
  expect(collection.records).toHaveLength(30);
  expect(collection.records[0]).toMatchObject({ id: "vendor/model-29", tokens: 30, rank: 1 });
  expect(collection.records.at(-1)).toMatchObject({ id: "vendor/model-0", tokens: 1, rank: 30 });
  expect(collection.raw).toEqual(rows.map(({ date: _date, variant: _variant, ...row }) => row));
});

test("unidentified buckets cannot satisfy the minimum model count, malformed model usage is rejected", () => {
  const unnamed = Array.from({ length: 20 }, () => day("", "2026-10-03", 1, 0));
  expect(() => parseOpenRouterUsage(JSON.stringify({ data: unnamed }))).toThrow("no longer expose per-model usage");
  const rows = Array.from({ length: 20 }, (_, index) => day(`vendor/model-${index}`, "2026-10-03", index, 0));
  expect(() =>
    parseOpenRouterUsage(JSON.stringify({ data: [...rows, { ...rows[0], total_prompt_tokens: -1 }] })),
  ).toThrow();
});
