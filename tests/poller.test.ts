import { expect, test } from "bun:test";
import { z } from "zod";
import { unexplainedFailure } from "../src/poller.js";

test("a withheld failure still says which kind it was, and nothing an upstream wrote", () => {
  const parsed = z.object({ data: z.array(z.string()) }).safeParse({ data: "sk-live-secret" });
  expect(unexplainedFailure(parsed.error)).toBe("Collection failed: response did not match the schema (ZodError)");
  const reset = Object.assign(new TypeError("fetch failed for https://x.test/?key=sk-live-secret"), {
    cause: { code: "ECONNRESET" },
  });
  expect(unexplainedFailure(reset)).toBe("Collection failed: network error (TypeError, ECONNRESET)");
  expect(unexplainedFailure(reset)).not.toContain("secret");
  // A code is repeated only when it has the shape of one the runtime chose.
  const odd = Object.assign(new Error("boom"), { code: "api key sk-live-secret" });
  expect(unexplainedFailure(odd)).toBe("Collection failed: network error (Error)");
});
