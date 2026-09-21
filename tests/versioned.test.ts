import { expect, test } from "bun:test";
import { versioned } from "../src/events/render/discord.js";

test("a docs page slug reads as a version, and dates and number runs stay as they were", () => {
  expect(versioned("Grok 4 8")).toBe("Grok 4.8");
  expect(versioned("Claude 3 5 sonnet")).toBe("Claude 3.5 sonnet");
  expect(versioned("Gemini 2 0 flash")).toBe("Gemini 2.0 flash");
  expect(versioned("Release notes 2026 09 21")).toBe("Release notes 2026 09 21");
  expect(versioned("Steps 1 2 3")).toBe("Steps 1 2 3");
  expect(versioned("Models")).toBe("Models");
});
