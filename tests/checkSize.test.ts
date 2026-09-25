import { describe, expect, test } from "bun:test";
import { budgetFor, measure, tooLong } from "../scripts/check-size.js";

describe("the declaration size ratchet", () => {
  test("counts code, not the comments that explain it", () => {
    const declaration = [
      "/** What this is for. */",
      "export function run(): number {",
      "  // Why it is done this way, at some length,",
      "  // over two lines.",
      "",
      "  return 1;",
      "}",
    ].join("\n");
    expect(measure(declaration)).toBe(3);
  });

  test("a new declaration has to fit; an old one has to not grow", () => {
    const budget = { "src/a.ts:old": 100 };
    expect(tooLong([{ name: "src/b.ts:new", size: 40 }], budget, 80)).toEqual([
      "BUDGET records src/a.ts:old, which no longer exists. Remove the line.",
    ]);
    const [problem] = tooLong(
      [
        { name: "src/b.ts:new", size: 140 },
        { name: "src/a.ts:old", size: 95 },
      ],
      budget,
      80,
    );
    expect(problem).toContain("src/b.ts:new is 140 code lines");
    // The number to paste, so recording a new one is a decision rather than an arithmetic problem.
    expect(problem).toContain("record it in BUDGET as 150");
  });

  test("growing past a budget fails, and so does leaving a budget behind after shrinking", () => {
    const budget = { "src/a.ts:old": 100 };
    expect(tooLong([{ name: "src/a.ts:old", size: 101 }], budget, 80)[0]).toContain("over its recorded budget of 100");
    // A ratchet nobody tightens is a limit: shrinking to 60 has to lower the budget to 75.
    expect(tooLong([{ name: "src/a.ts:old", size: 60 }], budget, 80)[0]).toContain("Lower it to 75");
    // Within the headroom it was given, nothing is said.
    expect(tooLong([{ name: "src/a.ts:old", size: 90 }], budget, 80)).toEqual([]);
  });

  test("a budget is the size rounded up to the next 25, which is the headroom", () => {
    expect(budgetFor(81)).toBe(100);
    expect(budgetFor(100)).toBe(100);
    expect(budgetFor(101)).toBe(125);
  });
});
