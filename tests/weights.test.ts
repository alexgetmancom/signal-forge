import { expect, test } from "bun:test";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";
import { markNovelWeights, seedWeightTotals } from "../src/weights.js";

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

test("seeding takes a count back from a copy that only claimed it first", async () => {
  const db = openDatabase(":memory:");
  // The copy is read before the ledger knows anything, so it claims the count.
  const copy = markNovelWeights(
    db,
    sweep([weights("mirror/copy", 753_329_940_480, { created: "2026-09-14T09:44:59.000Z" })]),
    now,
  );
  expect(copy.records[0]?.notableReasons).toEqual(["novel-parameter-total"]);
  const catalogue = [
    {
      id: "lab/original",
      createdAt: "2026-03-02T10:00:00.000Z",
      safetensors: { total: 753_329_940_480 },
      private: false,
    },
  ];
  const result = await seedWeightTotals(db, async () => Response.json(catalogue));
  expect(result.totals).toBe(1);
  expect(db.query("SELECT first_model FROM weight_totals WHERE total=?").get(753_329_940_480)).toMatchObject({
    first_model: "lab/original",
  });
  // And the copy stops being news the next time it is read.
  const again = markNovelWeights(db, sweep([weights("mirror/copy", 753_329_940_480)]), now);
  expect(again.records[0]?.discoveryStatus).toBe("candidate");
});

test("seeding ignores derivatives, small models and anything already held by an older publication", async () => {
  const db = openDatabase(":memory:");
  const catalogue = [
    { id: "old/first", createdAt: "2026-01-01T00:00:00.000Z", safetensors: { total: 900_000_000_000 }, private: false },
    {
      id: "new/second",
      createdAt: "2026-05-01T00:00:00.000Z",
      safetensors: { total: 900_000_000_000 },
      private: false,
    },
    {
      id: "tuned/model",
      createdAt: "2026-01-01T00:00:00.000Z",
      safetensors: { total: 500_000_000_000 },
      cardData: { base_model: "old/first" },
      private: false,
    },
    { id: "small/model", createdAt: "2026-01-01T00:00:00.000Z", safetensors: { total: 1_000_000_000 }, private: false },
  ];
  const result = await seedWeightTotals(db, async () => Response.json(catalogue));
  expect(result.totals).toBe(1);
  expect(db.query("SELECT first_model FROM weight_totals WHERE total=?").get(900_000_000_000)).toMatchObject({
    first_model: "old/first",
  });
});
