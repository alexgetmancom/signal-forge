import { expect, test } from "bun:test";
import { z } from "zod";
import { unexplainedFailure } from "../src/failureDiagnosis.js";
import { byLongestWait } from "../src/poller.js";

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
  expect(unexplainedFailure(odd)).toBe("Collection failed: unexpected error (Error)");
  const busy = Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY" });
  expect(unexplainedFailure(busy)).toBe("Collection failed: local database error (SQLiteError, SQLITE_BUSY)");
});

test("a TypeError from our own parsing is a collector bug, not a network error", () => {
  // What `fetch` raises when it cannot connect, and what reading a field off undefined raises, are
  // the same class. Only the first sends anyone to the router.
  const transport = new TypeError("fetch failed");
  expect(unexplainedFailure(transport)).toBe("Collection failed: network error (TypeError)");
  const ours = new TypeError("undefined is not an object (evaluating 'payload.models.length')");
  expect(unexplainedFailure(ours)).toBe("Collection failed: collector bug (TypeError)");
  // The message is still never repeated, whichever side it came from.
  const leaky = new TypeError("undefined is not an object (evaluating 'body.sk-live-secret')");
  expect(unexplainedFailure(leaky)).not.toContain("secret");
});

test("a paced group's turn goes to the source that has waited longest, not to the earliest in the registry", () => {
  const job = (id: string) => ({ id }) as unknown as Parameters<typeof byLongestWait>[0][number];
  const jobs = [job("huggingface:google"), job("huggingface:internlm"), job("huggingface:XiaomiMiMo")];
  const checked: Record<string, string | null> = {
    "huggingface:google": "2026-09-24T15:18:20.656Z",
    "huggingface:internlm": "2026-09-22T14:45:12.389Z",
    // Never collected once, which is the longest wait there is.
    "huggingface:XiaomiMiMo": null,
  };
  const now = Date.parse("2026-09-24T15:30:00.000Z");
  expect(byLongestWait(jobs, (id) => checked[id] ?? null, now).map((entry) => entry.id)).toEqual([
    "huggingface:XiaomiMiMo",
    "huggingface:internlm",
    "huggingface:google",
  ]);
});
