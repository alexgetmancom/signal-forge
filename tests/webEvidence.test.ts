import { describe, expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import { eventAttachment } from "../src/events/render/attachment.js";
import { webStringChanges } from "../src/events/render/common.js";
import type { Collection, Event } from "../src/events/types.js";
import { narrowWebEvidence } from "../src/events/web.js";
import { openDatabase } from "../src/storage/database.js";
import { narrowStoredWebEvidence } from "../src/storage/webEvidence.js";
import { summaryMaterial } from "../src/summary/events.js";
import { anEvent as aStoredEvent } from "./fixtures/build.js";

/** A page that rewrites three strings out of many, which is what a vendor deploy looks like. */
const unchanged = Array.from({ length: 400 }, (_, index) => `Shared interface string number ${index}`);
const before = JSON.stringify({
  id: "public-entry-strings",
  name: "Claude: public interface strings",
  strings: [...unchanged, "Opus 4.9 is the default model", "A connector named exists"],
});
const after = JSON.stringify({
  id: "public-entry-strings",
  name: "Claude: public interface strings",
  strings: [...unchanged, "Opus 5 is in research preview", "Allow Claude to preview this page?"],
});

const strings = (json: string | null): unknown[] => {
  const parsed = JSON.parse(json ?? "{}") as { strings?: unknown };
  return Array.isArray(parsed.strings) ? parsed.strings : [];
};

const anEvent = (beforeJson: string | null, afterJson: string | null): Event =>
  ({
    id: 1,
    source: "claude-web",
    stream: "web",
    entity_id: "public-entry-strings",
    kind: "changed",
    before_json: beforeJson,
    after_json: afterJson,
    detected_at: "2026-10-03T00:00:00.000Z",
    confidence: "observed",
    evidence_type: "unknown",
    authority: "third_party",
    signal: null,
  }) as Event;

describe("narrowing a web change event", () => {
  test("keeps the strings that changed and drops the table around them", () => {
    const [narrowBefore, narrowAfter] = narrowWebEvidence(before, after);
    expect(strings(narrowBefore)).toEqual(["Opus 4.9 is the default model", "A connector named exists"]);
    expect(strings(narrowAfter)).toEqual(["Opus 5 is in research preview", "Allow Claude to preview this page?"]);
    expect((narrowBefore?.length ?? 0) + (narrowAfter?.length ?? 0)).toBeLessThan(before.length + after.length / 10);
  });

  test("every reader of these events sees exactly what it saw before", () => {
    const [narrowBefore, narrowAfter] = narrowWebEvidence(before, after);
    expect(webStringChanges(strings(narrowBefore), strings(narrowAfter))).toEqual(
      webStringChanges(strings(before), strings(after)),
    );
  });

  test("the attachment a message carries is unchanged", () => {
    const whole = eventAttachment(anEvent(before, after));
    const [narrowBefore, narrowAfter] = narrowWebEvidence(before, after);
    expect(eventAttachment(anEvent(narrowBefore, narrowAfter))).toEqual(whole);
  });

  test("keeps the fields beside the strings, which name the record", () => {
    const [, narrowAfter] = narrowWebEvidence(before, after);
    expect(JSON.parse(narrowAfter ?? "{}")).toMatchObject({
      id: "public-entry-strings",
      name: "Claude: public interface strings",
    });
  });

  test("narrowing a narrowed event changes nothing, so the repair can be run twice", () => {
    const once = narrowWebEvidence(before, after);
    expect(narrowWebEvidence(once[0], once[1])).toEqual(once);
  });

  test("a first sighting keeps the state it recorded, having nothing to diff against", () => {
    expect(narrowWebEvidence(null, after)).toEqual([null, after]);
  });

  test("a record that is not a string table is left alone", () => {
    const record = JSON.stringify({ id: "a", price: 3 });
    expect(narrowWebEvidence(record, record)).toEqual([record, record]);
  });

  test("a string whose only difference is Markdown around it did not change", () => {
    const plain = JSON.stringify({ strings: ["Opus 5 is `here`"] });
    const marked = JSON.stringify({ strings: ["- Opus 5 is here"] });
    const [narrowBefore, narrowAfter] = narrowWebEvidence(plain, marked);
    expect(strings(narrowBefore)).toEqual([]);
    expect(strings(narrowAfter)).toEqual([]);
  });
});

describe("narrowing on the way in", () => {
  const db = openDatabase(":memory:");
  const page = (...lines: string[]): Collection => ({
    source: "claude-web",
    stream: "web",
    url: "https://claude.ai",
    raw: [],
    records: [{ id: "public-entry-strings", name: "Claude: public interface strings", strings: lines }],
  });
  const stored = () =>
    db.query("SELECT before_json, after_json FROM events ORDER BY id DESC").get() as {
      before_json: string | null;
      after_json: string | null;
    };

  test("a stored change holds the diff, and the next one is still detected", () => {
    saveCollection(db, page(...unchanged, "Opus 4.9 is the default model"), []);
    saveCollection(db, page(...unchanged, "Opus 5 is in research preview"), []);
    const row = stored();
    expect(strings(row.before_json)).toEqual(["Opus 4.9 is the default model"]);
    expect(strings(row.after_json)).toEqual(["Opus 5 is in research preview"]);

    // The next change is found by comparing the `records` table, not the narrowed event.
    expect(saveCollection(db, page(...unchanged, "Opus 5 is generally available"), []).events).toBe(1);
    expect(strings(stored().before_json)).toEqual(["Opus 5 is in research preview"]);
    // Collecting the same page again is still no change at all.
    expect(saveCollection(db, page(...unchanged, "Opus 5 is generally available"), []).events).toBe(0);
  });

  test("the repair narrows what was stored before it existed, once", () => {
    db.exec("DELETE FROM events");
    aStoredEvent(db, {
      source: "claude-web",
      stream: "web",
      entityId: "public-entry-strings",
      kind: "changed",
      beforeJson: before,
      afterJson: after,
    });
    const first = narrowStoredWebEvidence(db, { minBytes: 4_096, limit: 100 });
    expect(first.narrowed).toBe(1);
    expect(first.freedBytes).toBeGreaterThan(before.length / 2);
    expect(strings(stored().after_json)).toEqual([
      "Opus 5 is in research preview",
      "Allow Claude to preview this page?",
    ]);
    // Narrowed rows no longer exceed the threshold, so a second run has nothing to do.
    expect(narrowStoredWebEvidence(db, { minBytes: 4_096, limit: 100 })).toMatchObject({ examined: 0, narrowed: 0 });
  });
});

test("a web change that only reflowed Markdown gives the summariser the diff, not the page", () => {
  const page = (strings: string[]) => JSON.stringify({ id: "a", name: "Docs", strings });
  const event = anEvent(page(["# Site tools", "Use `GPT-6` for this"]), page(["# Site tools", "Use GPT-6 for this"]));
  expect(summaryMaterial(event)).toBe("No material user-facing text changed.");
  // Narrowing leaves the same answer, because there was never a material change to carry.
  const [narrowBefore, narrowAfter] = narrowWebEvidence(event.before_json, event.after_json);
  expect(summaryMaterial(anEvent(narrowBefore, narrowAfter))).toBe("No material user-facing text changed.");
});
