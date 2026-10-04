import { expect, test } from "bun:test";
import { fieldMoves } from "../scripts/bodyFieldMoves.js";

const before = new Map([
  ["huggingface:meta-llama a", ["id", "name", "access"]],
  ["huggingface:meta-llama b", ["id", "name", "access"]],
  ["openrouter c", ["id", "name", "updated"]],
]);

test("a field leaving stored bodies is named, counted and placed", () => {
  const after = new Map([
    ["huggingface:meta-llama a", ["id", "name"]],
    ["huggingface:meta-llama b", ["id", "name"]],
  ]);
  expect(fieldMoves(["huggingface:meta-llama a", "huggingface:meta-llama b"], before, after)).toEqual([
    { field: "access", left: 2, arrived: 0, carriedOnACard: true },
  ]);
});

test("a field a card never shows is reported without being a reason to stop", () => {
  const after = new Map([["openrouter c", ["id", "name"]]]);
  const moves = fieldMoves(["openrouter c"], before, after);
  // `updated` is in NOISE: it leaves the body and no reader is any the wiser.
  expect(moves).toEqual([{ field: "updated", left: 1, arrived: 0, carriedOnACard: false }]);
});

test("a body rewritten without gaining or losing a field moves no field at all", () => {
  const after = new Map([["openrouter c", ["id", "name", "updated"]]]);
  expect(fieldMoves(["openrouter c"], before, after)).toEqual([]);
});
