import { expect, test } from "bun:test";
import { canonical, splitMessage } from "../src/events/canonical.js";
import { isRoutine } from "../src/events/interpretation.js";
import { embedCharacters, MESSAGE_CHARACTERS, oneMessage } from "../src/events/render/budget.js";
import { dollars, priceChip, priceChips, priceSentence, priceStep } from "../src/events/render/price.js";
import type { Event } from "../src/events/types.js";
import { rosterSiblings, usageRanks, witnessedSubjects } from "../src/events/witness.js";
import { openDatabase } from "../src/storage/database.js";

const event = (fields: Partial<Event>): Event => ({
  signal: null,
  id: 1,
  source: "openrouter",
  stream: "openrouter",
  entity_id: "vendor/model",
  kind: "changed",
  before_json: null,
  after_json: null,
  detected_at: "2026-09-11T02:00:00.000Z",
  ...fields,
});

const priced = (before: Record<string, string>, after: Record<string, string>, fields: Partial<Event> = {}): Event =>
  event({
    before_json: JSON.stringify({ name: "Model", pricing: before }),
    after_json: JSON.stringify({ name: "Model", pricing: after }),
    ...fields,
  });

test("a message budget counts what Discord counts: author, title, description, fields and footer", () => {
  expect(
    embedCharacters({
      author: { name: "ab" },
      title: "cde",
      description: "f",
      footer: { text: "gh" },
      fields: [{ name: "i", value: "jk" }],
    }),
  ).toBe(11);
  expect(embedCharacters({})).toBe(0);
});

test("a message carries one card unless it is told it may carry more, and the rest travel as extras", () => {
  const { page, extra } = oneMessage([{ description: "a" }, { description: "b" }]);
  expect(page).toHaveLength(1);
  expect(extra).toHaveLength(1);
});

test("a page is filled until the next card would not fit, but never left empty", () => {
  const cards = ["a", "b", "c"].map((letter) => ({ description: letter.repeat(10) }));
  expect(oneMessage(cards, 25, 5).page).toHaveLength(2);
  expect(oneMessage([{ description: "a".repeat(200) }, { description: "b" }], 100, 5).page).toHaveLength(1);
});

test("one card larger than the whole message is trimmed in place to fit it, and says so", () => {
  const card = { title: "t", description: "x".repeat(7000) };
  const { page } = oneMessage([card]);
  expect(page[0]).toBe(card);
  expect(embedCharacters(card)).toBeLessThanOrEqual(MESSAGE_CHARACTERS);
  expect(card.description.endsWith("…")).toBe(true);
});

test("a price is said by how far it moved, and a move that rounds to nothing is not said as zero", () => {
  expect(priceStep(10, 7)).toBe("−30%");
  expect(priceStep(10, 14)).toBe("+40%");
  expect(priceStep(10, 19.4)).toBe("+94%");
  expect(priceStep(10, 20)).toBe("2×");
  expect(priceStep(10, 30)).toBe("3×");
  expect(priceStep(1000, 1004)).toBe("+0.4%");
  expect(priceStep(100, 99.7)).toBe("−0.3%");
});

test("a price sentence names the venue and says which way the rate the reader pays most went", () => {
  const cheaper = priced(
    { prompt: "0.000001", completion: "0.000002" },
    { prompt: "0.0000007", completion: "0.0000014" },
  );
  const dearer = priced({ prompt: "0.000001" }, { prompt: "0.000002" });
  const sentence = (e: Event) => priceSentence(e, JSON.parse(e.before_json ?? "{}"), JSON.parse(e.after_json ?? "{}"));
  expect(sentence(cheaper)).toBe("30% cheaper on OpenRouter.");
  expect(sentence(dearer)).toBe("2× more expensive on OpenRouter.");
  expect(sentence(priced({ prompt: "0.000001" }, { prompt: "0.000001" }))).toBeNull();
});

test("rates are chips, one per rate, and a sheet with no in or out rate is quoted as it came", () => {
  expect(priceChips("$0.1 in · $0.5 out / 1M tokens")).toEqual(["$0.1 in", "$0.5 out"]);
  expect(priceChip("$0.1 in · $0.5 out / 1M tokens")).toBe("$0.1 in · $0.5 out");
  expect(priceChips("free")).toEqual(["free"]);
  expect([dollars(0.5), dollars(0.1234), dollars(3), dollars(12.345)]).toEqual(["$0.5", "$0.123", "$3", "$12.35"]);
});

test("two records with the same members in a different order are the same record", () => {
  expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  expect(canonical({ a: 1 })).not.toBe(canonical({ a: "1" }));
});

test("keys are ordered by codepoint, so identity does not depend on the host's locale tables", () => {
  expect(canonical({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
});

test("a long message is cut at a line where it can be, and never through a surrogate pair", () => {
  expect(splitMessage("aaa\nbbb\nccc", 5)).toEqual(["aaa", "bbb", "ccc"]);
  expect(splitMessage("short", 10)).toEqual(["short"]);
  expect(splitMessage("😀😀😀", 3)).toEqual(["😀", "😀", "😀"]);
  expect(splitMessage("", 10)).toEqual([]);
});

test("a vendor's own release channel moves immediately, and a nightly one rides the digest", () => {
  const packages = (entity: string) =>
    event({ stream: "packages", entity_id: entity, before_json: "{}", after_json: "{}" });
  expect(isRoutine(packages("nightly"))).toBe(true);
  expect(isRoutine(packages("latest"))).toBe(false);
  expect(isRoutine(event({ source: "claude-web" }))).toBe(true);
});

test("a catalogue price moving by fractions waits for the digest, and one that doubles does not", () => {
  expect(isRoutine(priced({ prompt: "0.000001" }, { prompt: "0.00000104" }))).toBe(true);
  expect(isRoutine(priced({ prompt: "0.000001" }, { prompt: "0.000002" }))).toBe(false);
});

test("a renamed model is never routine, whatever else stayed the same", () => {
  const renamed = event({
    before_json: JSON.stringify({ name: "A", pricing: { prompt: "0.000001" } }),
    after_json: JSON.stringify({ name: "B", pricing: { prompt: "0.000001" } }),
  });
  expect(isRoutine(renamed)).toBe(false);
});

test("a first-place leaderboard movement is told at once, and other churn is not", () => {
  const board = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    event({
      stream: "leaderboards",
      before_json: JSON.stringify(before),
      after_json: JSON.stringify(after),
    });
  expect(isRoutine(board({ rank: 2 }, { rank: 1 }))).toBe(false);
  expect(isRoutine(board({ rank: 5 }, { rank: 4 }))).toBe(true);
});

test("one damaged record body costs a reader of the roster that row and nothing else", () => {
  const db = openDatabase(":memory:");
  const put = (source: string, id: string, stream: string, body: string): void => {
    db.query("INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,?,?)").run(
      source,
      id,
      body,
      stream,
      "2026-10-02T12:00:00.000Z",
    );
  };
  put("openrouter-usage", "good", "usage", JSON.stringify({ id: "Acme Fast 1", rank: 3 }));
  put("openrouter-usage", "torn", "usage", '{"id": "Acme Slow 2", "ra');
  put("openrouter-usage", "null", "usage", "null");
  put("openrouter-usage", "list", "usage", "[1,2]");
  put("arena", "a", "arena", JSON.stringify({ name: "Acme Fast 1" }));
  put("arena", "b", "arena", "not json at all");
  put("arena", "c", "arena", "null");
  put("arena", "d", "arena", JSON.stringify({ name: "Acme Fast 1 Low", maker: "Acme" }));
  put("arena", "e", "arena", JSON.stringify({ name: "Acme Fast 1 High", maker: "Acme" }));
  put("arena", "f", "arena", JSON.stringify({ name: "Acme Fast 1 Odd", maker: "Other" }));

  expect([...usageRanks(db).values()]).toEqual([3]);
  expect(witnessedSubjects(db).size).toBeGreaterThan(0);
  expect(rosterSiblings(db, "arena", "a", "Acme Fast 1", "Acme").map((record) => record.name)).toEqual([
    "Acme Fast 1 High",
    "Acme Fast 1 Low",
  ]);
});
