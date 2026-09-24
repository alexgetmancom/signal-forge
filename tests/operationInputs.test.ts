import { expect, test } from "bun:test";
import { eventAttachment } from "../src/events/render/attachment.js";
import type { Event } from "../src/events/types.js";
import { flag } from "../src/operations/definition.js";

test("a switch arriving as text means what it says", () => {
  const all = flag();
  // `z.coerce.boolean()` is `Boolean(value)`, under which every one of these is true.
  expect(all.parse("false")).toBe(false);
  expect(all.parse("0")).toBe(false);
  expect(all.parse("no")).toBe(false);
  expect(all.parse("true")).toBe(true);
  expect(all.parse("1")).toBe(true);
  expect(all.parse(true)).toBe(true);
  expect(all.parse(false)).toBe(false);
  // A word nobody meant as a switch is a mistake worth reporting rather than guessing at.
  expect(() => all.parse("perhaps")).toThrow();
});

test("an attachment is cut to a size the upload accepts, not to a count of characters", () => {
  // Three bytes per character, and long enough to count as a meaningful web string. Forty thousand
  // of these is several megabytes, well past the million-byte limit the upload accepts.
  const line = "モデルのコンテキスト設定が変更されました model context";
  const strings = Array.from({ length: 40_000 }, (_, index) => `${line} ${index}`);
  const event = {
    id: 1,
    source: "pages:example",
    stream: "web",
    kind: "changed",
    entity_id: "example",
    detected_at: "2026-09-24T00:00:00.000Z",
    before_json: JSON.stringify({ name: "Example", strings: [] }),
    after_json: JSON.stringify({ name: "Example", strings }),
  } as unknown as Event;

  const attachment = eventAttachment(event);
  expect(attachment).not.toBeNull();
  const bytes = Buffer.byteLength(attachment?.content ?? "", "utf8");
  expect(bytes).toBeLessThanOrEqual(1_000_000);
  // Cut on a character boundary: a buffer sliced mid-character decodes to a replacement character.
  expect(attachment?.content).not.toContain("�");
});
