import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { eventAttachment } from "../src/events/render/attachment.js";
import type { Event } from "../src/events/types.js";
import { cliFieldName } from "../src/guide.js";
import { cliInput } from "../src/operations/cliInput.js";
import { flag } from "../src/operations/definition.js";
import { operations } from "../src/operations.js";
import { openDatabase } from "../src/storage/database.js";

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

test("every field an operation accepts can be set from the command line", () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({
    CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  });
  const unreachable: string[] = [];
  const registry = operations(db, config);
  for (const [name, definition] of Object.entries(registry)) {
    if (!definition.cli) continue;
    for (const field of Object.keys(definition.schema.shape)) {
      // Either a position in the usage line, or a `--field` the parser turns into that field.
      const positional = (definition.cli.args ?? []).some((argument) => argument.name === field);
      const flagged = cliInput(registry, name, [`--${cliFieldName(field)}`, "x"]);
      if (!positional && !(field in flagged)) unreachable.push(`${name}.${field}`);
    }
  }
  // The registry projects one operation onto four surfaces. HTTP and MCP hand over a whole object;
  // the CLI used to hand over a list, so nine filters across five commands were unreachable from
  // the surface this repository is actually operated from, with no error to say so.
  expect(unreachable).toEqual([]);
  db.close();
});

test("the operator CLI rejects input it would previously ignore or misread", () => {
  const db = openDatabase(":memory:");
  const registry = operations(
    db,
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
  );

  expect(() => cliInput(registry, "news", ["12", "launch", "extra"])).toThrow("Unexpected argument: extra");
  expect(() => cliInput(registry, "guide", ["--al"])).toThrow("Unknown option --al");
  expect(() => cliInput(registry, "stories", ["--minConfidence", "shipped"])).toThrow("Unknown option --minConfidence");
  expect(() => cliInput(registry, "news", ["--hours"])).toThrow("Option --hours needs a value");
  expect(() => cliInput(registry, "news", ["--hours", "12", "--hours", "24"])).toThrow("given twice");
  expect(() => cliInput(registry, "sent", ["12", "--hours", "24"])).toThrow("given both positionally and as an option");

  expect(cliInput(registry, "guide", ["--all", "health"])).toEqual({ all: true, section: "health" });
  expect(cliInput(registry, "guide", ["--all=false", "health"])).toEqual({ all: "false", section: "health" });
  expect(cliInput(registry, "news", ["--signal", "launch", "--hours", "12"])).toEqual({
    hours: "12",
    signal: "launch",
  });
  expect(cliInput(registry, "sql", ["--", "-- a query beginning with a comment"])).toEqual({
    query: "-- a query beginning with a comment",
  });
  db.close();
});
