import { expect, test } from "bun:test";
import { asTsv } from "../src/text.js";

test("rows print as a table, and an answer that is not rows keeps its punctuation", () => {
  const table = asTsv({
    rows: [
      { source: "arena", n: 17 },
      { source: "pages:claude-docs", n: 21 },
    ],
  });
  expect(table).toBe("source\tn\narena\t17\npages:claude-docs\t21");

  // A row missing a column still lines up, because the columns are the union of what the rows have.
  expect(asTsv({ rows: [{ a: 1 }, { a: 2, b: "x" }] })).toBe("a\tb\n1\t\n2\tx");
  // A tab inside a value would invent a column; a newline would invent a row.
  expect(asTsv({ rows: [{ a: "one\ttwo\nthree" }] })).toBe("a\none two three");
  // Nested answers stay JSON: there the punctuation is the meaning.
  expect(asTsv({ sources: [{ verdict: "earning" }] })).toBeNull();
  expect(asTsv({ rows: [] })).toBeNull();
  expect(asTsv("plain")).toBeNull();
});
