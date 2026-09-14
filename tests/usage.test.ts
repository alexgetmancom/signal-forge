import { expect, test } from "bun:test";
import { parseOpenRouterUsage } from "../src/sources/usage.js";

/** The shape the rankings page streams its data in: dehydrated queries inside the flight payload. */
function page(rows: Record<string, unknown>[]): string {
  const flight = `92:${JSON.stringify([
    "$",
    "$L113",
    null,
    { state: { mutations: [], queries: [{ dehydratedAt: 1, state: { data: rows } }] } },
  ])}\n`;
  return `<html><body><script>self.__next_f.push(${JSON.stringify([1, flight])})</script></body></html>`;
}

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
  const collection = parseOpenRouterUsage(page(rows));
  expect(collection.source).toBe("openrouter-usage");
  // Usage moves every hour and none of those moves is news: only a first appearance is an event.
  expect(collection.appendOnly).toBe(true);
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
  expect(() => parseOpenRouterUsage(page([day("vendor/model", "2026-09-13 00:00:00", 1, 1)]))).toThrow(
    "OpenRouter rankings no longer expose per-model usage",
  );
});
