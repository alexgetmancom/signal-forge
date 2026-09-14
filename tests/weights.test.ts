import { expect, test } from "bun:test";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";
import { markNovelWeights } from "../src/weights.js";

const now = "2026-09-14T12:00:00.000Z";

function sweep(records: Collection["records"]): Collection {
  return {
    source: "discovery:huggingface-recent",
    stream: "weights",
    url: "https://huggingface.co/api/models",
    raw: {},
    appendOnly: true,
    records,
  };
}

const weights = (id: string, parameters: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  parameters,
  derivative: false,
  discoveryStatus: "candidate",
  notableReasons: [] as string[],
  ...extra,
});

test("the first publisher of a parameter count is notable and a later copy is not", () => {
  const db = openDatabase(":memory:");
  const first = markNovelWeights(db, sweep([weights("lab/original", 753_329_940_480)]), now);
  expect(first.records[0]).toMatchObject({
    discoveryStatus: "notable",
    notableReasons: ["novel-parameter-total"],
  });
  // A week later, somebody republishes the same weights under their own name and declares no base
  // model. Nothing in that response distinguishes it; the ledger does.
  const later = markNovelWeights(db, sweep([weights("mirror/copy", 753_329_940_480)]), now);
  expect(later.records[0]).toMatchObject({ discoveryStatus: "candidate", notableReasons: [] });
});

test("re-reading the original keeps the same verdict", () => {
  const db = openDatabase(":memory:");
  const body = () => markNovelWeights(db, sweep([weights("lab/original", 400_000_000_000)]), now).records[0];
  // A verdict that flipped on the second poll would report a change that never happened: bodies are
  // compared byte for byte.
  expect(JSON.stringify(body())).toBe(JSON.stringify(body()));
  expect(body()).toMatchObject({ notableReasons: ["novel-parameter-total"] });
});

test("a declared derivative, a small model and a model with no weights claim nothing", () => {
  const db = openDatabase(":memory:");
  const collection = markNovelWeights(
    db,
    sweep([
      weights("derived/tune", 753_329_940_480, { derivative: true }),
      weights("small/adapter", 1_000_000_000),
      weights("empty/repository", null),
    ]),
    now,
  );
  for (const record of collection.records) expect(record.discoveryStatus).toBe("candidate");
  // None of them may claim the count either: the original must still be able to.
  const original = markNovelWeights(db, sweep([weights("lab/original", 753_329_940_480)]), now);
  expect(original.records[0]?.notableReasons).toEqual(["novel-parameter-total"]);
});

test("a reason the collector already found survives the ledger", () => {
  const db = openDatabase(":memory:");
  const collection = markNovelWeights(
    db,
    sweep([weights("lab/original", 300_000_000_000, { notableReasons: ["likes-within-12h"] })]),
    now,
  );
  expect(collection.records[0]?.notableReasons).toEqual(["likes-within-12h", "novel-parameter-total"]);
});
