import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { coverageGaps } from "../src/reports/coverageGaps.js";
import { openDatabase } from "../src/storage/database.js";

const hn = (stories: { id: string; name: string; url: string }[]): Collection => ({
  source: "hackernews",
  stream: "news",
  url: "https://news.ycombinator.com",
  raw: [],
  records: stories.map((story) => ({ ...story, discussion: `https://news.ycombinator.com/item?id=${story.id}` })),
});

test("a front-page story nothing else recorded is a gap; one another source saw is not", () => {
  const db = openDatabase(":memory:");
  saveCollection(db, hn([{ id: "0", name: "baseline", url: "https://example.com/0" }]), [], "2026-09-10T00:00:00.000Z");
  saveCollection(
    db,
    {
      source: "pages:google",
      stream: "pages",
      url: "https://ai.google.dev",
      raw: [],
      records: [{ id: "/old", name: "Old" }],
    },
    [],
    "2026-09-10T00:00:00.000Z",
  );
  // Google's docs named the model a day before the front page did.
  saveCollection(
    db,
    {
      source: "pages:google",
      stream: "pages",
      url: "https://ai.google.dev",
      raw: [],
      records: [
        { id: "/old", name: "Old" },
        { id: "/gemini-api/docs/models/gemini-3.8-live", name: "Google AI for Developers: Gemini 3.8 live" },
      ],
    },
    [],
    "2026-09-15T18:00:00.000Z",
  );
  saveCollection(
    db,
    hn([
      { id: "0", name: "baseline", url: "https://example.com/0" },
      { id: "1", name: "Gemini 3.8 Live and 3.8 Live Extended Thinking", url: "https://blog.google/gemini-3-8-live" },
      {
        id: "2",
        name: "Mistral X Mozilla: Private, Multilingual AI Browsing",
        url: "https://mistral.ai/news/mistral-x-mozilla/",
      },
    ]),
    [],
    "2026-09-16T08:00:00.000Z",
  );
  const report = coverageGaps(db, 7, Date.parse("2026-09-19T00:00:00.000Z"));
  expect(report.stories).toBe(2);
  expect(report.gaps.map((gap) => gap.title)).toEqual(["Mistral X Mozilla: Private, Multilingual AI Browsing"]);
  db.close();
});
