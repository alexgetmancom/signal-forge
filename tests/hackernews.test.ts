import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { parseHackerNews } from "../src/sources/news.js";

test("Hacker News keeps front-page stories that name a followed maker, and never makes a card", () => {
  const collection = parseHackerNews(
    JSON.stringify({
      hits: [
        {
          objectID: "45100001",
          title: "Gemini 3.8 Live and 3.8 Live Extended Thinking",
          url: "https://blog.google/gemini-3-8-live",
          points: 480,
          created_at: "2026-09-16T08:00:00.000Z",
        },
        {
          objectID: "45100002",
          title: "Saving Jet Fuel",
          url: null,
          points: 130,
          created_at: "2026-09-16T09:00:00.000Z",
        },
      ],
    }),
  );
  expect(collection).toMatchObject({ source: "hackernews", stream: "news", appendOnly: true });
  expect(collection.records).toEqual([
    {
      id: "45100001",
      name: "Gemini 3.8 Live and 3.8 Live Extended Thinking",
      url: "https://blog.google/gemini-3-8-live",
      discussion: "https://news.ycombinator.com/item?id=45100001",
      published: "2026-09-16T08:00:00.000Z",
    },
  ]);
  const event: Event = {
    id: 1,
    source: "hackernews",
    stream: "news",
    entity_id: "45100001",
    kind: "new",
    before_json: null,
    after_json: JSON.stringify(collection.records[0]),
    detected_at: "2026-09-16T08:30:00.000Z",
  };
  expect(signalClass(event)).toBe("article");
  expect(() => parseHackerNews(JSON.stringify({ hits: "no" }))).toThrow();
});
