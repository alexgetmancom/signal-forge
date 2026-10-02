import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import { SourceError } from "../src/failure.js";
import {
  parseMiniMaxCodeChangelog,
  parseMistralReleaseNotes,
  parseOpenAIChatGPTReleaseNotes,
} from "../src/sources/releaseNotes.js";
import { openDatabase } from "../src/storage/database.js";

/** What a parser throws, so the test can read its type rather than its sentence. */
function failure(read: () => unknown): SourceError {
  try {
    read();
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw new Error(`expected a SourceError and got ${String(error)}`);
  }
  throw new Error("expected the parser to throw");
}

test("a page that moved is missing-content, and a date that does not parse is a schema failure, by type", () => {
  expect(failure(() => parseOpenAIChatGPTReleaseNotes("<html>new layout</html>")).kind).toBe("missing-content");
  // Mistral switching its `dateTime` attribute to a full timestamp.
  const timestamp = `<main><time dateTime="2026-09-18T10:00:00Z"></time><h2>Mistral Large 4</h2><p>New.</p></main>`;
  expect(failure(() => parseMistralReleaseNotes(timestamp)).kind).toBe("schema");
  // A day that does not exist.
  const impossible = `<Tab title="CLI">\n## 0.4.12 · 2026-09-18\nGood.\n## 0.4.11 · 2026-02-31\nBad day.\n</Tab>`;
  expect(failure(() => parseMiniMaxCodeChangelog(impossible)).kind).toBe("schema");
});

test("one date that does not parse fails the read, so a changed date format cannot hide the newest entries", () => {
  const page = `<Tab title="CLI">\n## 0.4.13 · 2026-09-19\nNewest.\n## 0.4.12 · 2026-02-31\nBad.\n## 0.4.11 · 2026-09-17\nOlder.\n</Tab>`;
  expect(() => parseMiniMaxCodeChangelog(page)).toThrow("invalid publication date");
});

const day = (...entries: [string, string][]) =>
  `<article><h1>September 18, 2026</h1>${entries.map(([title, body]) => `<h2>${title}</h2><p>${body}</p>`).join("")}</article>`;

test("two entries of one day under one title get distinct ids, and the one that was there longest keeps its own", () => {
  // The page lists the newest first, so the second paragraph is the older entry.
  const twice = parseOpenAIChatGPTReleaseNotes(day(["Improvements", "Newer."], ["Improvements", "Older."]));
  const byBody = (parsed: typeof twice, body: string) => parsed.records.find((r) => String(r.summary).includes(body));
  expect(byBody(twice, "Older.")?.id).toBe("2026-09-18:improvements");
  expect(byBody(twice, "Newer.")?.id).toBe("2026-09-18:improvements-2");

  // A third arrival above them takes the next suffix and moves nobody else's id.
  const thrice = parseOpenAIChatGPTReleaseNotes(
    day(["Improvements", "Newest."], ["Improvements", "Newer."], ["Improvements", "Older."]),
  );
  expect(byBody(thrice, "Older.")?.id).toBe("2026-09-18:improvements");
  expect(byBody(thrice, "Newer.")?.id).toBe("2026-09-18:improvements-2");
  expect(byBody(thrice, "Newest.")?.id).toBe("2026-09-18:improvements-3");
});

test("a suffix is never an id that is already on the page", () => {
  const parsed = parseOpenAIChatGPTReleaseNotes(day(["Update", "A."], ["Update 2", "B."], ["Update", "C."]));
  const ids = parsed.records.map((record) => record.id);
  expect(new Set(ids).size).toBe(3);
  expect(ids).toContain("2026-09-18:update-2");
});

test("a page with a repeated title is stored whole instead of being refused whole", () => {
  const db = openDatabase(":memory:");
  const parsed = parseOpenAIChatGPTReleaseNotes(day(["Improvements", "Newer."], ["Improvements", "Older."]));
  expect(() => saveCollection(db, parsed, [], "2026-09-18T12:00:00.000Z")).not.toThrow();
  const stored = db.query<{ id: string }, []>("SELECT id FROM records ORDER BY id").all();
  expect(stored.map((row) => row.id)).toEqual(["2026-09-18:improvements", "2026-09-18:improvements-2"]);
  db.close();
});

test("a page without repeated titles keeps every id and its order", () => {
  const parsed = parseOpenAIChatGPTReleaseNotes(day(["Alpha", "One."], ["Beta", "Two."], ["Gamma", "Three."]));
  expect(parsed.records.map((record) => record.id)).toEqual([
    "2026-09-18:alpha",
    "2026-09-18:beta",
    "2026-09-18:gamma",
  ]);
});
