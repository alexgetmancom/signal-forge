import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import { SourceError } from "../src/failure.js";
import {
  parseGeminiApiChangelog,
  parseKimiCodeChangelog,
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

test("a heading that is written as a date and does not read as one fails the read, whatever it is the heading of", () => {
  // The newest entries are the ones a vendor's new format reaches first, and skipping them as
  // "not a date" left the source healthy and the newest release missing from it.
  const page = (newest: string) =>
    `<article><h1>${newest}</h1><h2>New</h2><p>Newest.</p><h1>September 17, 2026</h1><h2>Old</h2><p>Older.</p></article>`;
  for (const written of [
    "Sep. 18, 2026",
    "18 September 2026",
    "9/18/2026",
    "September 31, 2026",
    "September 18, 2026 (updated)",
  ])
    expect(failure(() => parseOpenAIChatGPTReleaseNotes(page(written))).kind).toBe("schema");
  // A heading that is not a date at all is navigation, and is still left out.
  const navigation = parseOpenAIChatGPTReleaseNotes(
    `<article><h1>Release notes</h1><h1>Version 2 notes</h1><h1>September 17, 2026</h1><h2>Old</h2><p>Older.</p></article>`,
  );
  expect(navigation.records.map((record) => record.id)).toEqual(["2026-09-17:old"]);

  const gemini = (heading: string) =>
    `<main><h1>Changelog</h1><h2 data-text="${heading}">${heading}</h2><p>New.</p><h2 data-text="September 2, 2026">September 2, 2026</h2><p>Old.</p></main>`;
  expect(failure(() => parseGeminiApiChangelog(gemini("Sep. 3, 2026"))).kind).toBe("schema");
  expect(failure(() => parseGeminiApiChangelog(gemini("September 31, 2026"))).kind).toBe("schema");
  expect(parseGeminiApiChangelog(gemini("September 3, 2026")).records).toHaveLength(2);
  const related = parseGeminiApiChangelog(
    `<main><h2>Related pages</h2><h2 data-text="September 2, 2026">September 2, 2026</h2><p>Old.</p></main>`,
  );
  expect(related.records.map((record) => record.id)).toEqual(["2026-09-02"]);
});

test("a date written without its comma is read, on the page that has one", () => {
  // `December 13 2023` is in Gemini's own archive. "Written as a date" allowed the comma to be
  // missing and the reader required it, so that one old entry failed the whole read -- 139 entries
  // and every new release with it -- while the heading had been plain all along.
  const gemini = (heading: string) => `<main><h2 data-text="${heading}">${heading}</h2><p>New.</p></main>`;
  expect(parseGeminiApiChangelog(gemini("December 13 2023")).records[0]?.published).toBe("2023-12-13T00:00:00.000Z");
  expect(parseGeminiApiChangelog(gemini("December 13, 2023")).records[0]?.published).toBe("2023-12-13T00:00:00.000Z");
  const chatgpt = parseOpenAIChatGPTReleaseNotes(
    `<article><h1>September 18 2026</h1><h2>New</h2><p>Newest.</p></article>`,
  );
  expect(chatgpt.records.map((record) => record.id)).toEqual(["2026-09-18:new"]);
});

test("Kimi leaves out the one entry it knows is dated to a month, and fails on any other date it cannot read", () => {
  const entry = (date: string, version: string) =>
    `<div class="wn-entry"><div class="wn-meta"><span class="wn-product">Kimi Code CLI</span><h2><span class="ignore-header">${version}</span> <span class="wn-date">${date}</span></h2></div><div class="wn-content"><p>Notes.</p></div></div>`;
  const known = parseKimiCodeChangelog(entry("September 14, 2026", "v0.43.0") + entry("May 2026", "v0.1.0"));
  expect(known.records).toHaveLength(1);
  for (const written of ["14 Sept 2026", "September 31, 2026", "yesterday"])
    expect(
      failure(() => parseKimiCodeChangelog(entry(written, "v0.44.0") + entry("September 14, 2026", "v0.43.0"))).kind,
    ).toBe("schema");
});
