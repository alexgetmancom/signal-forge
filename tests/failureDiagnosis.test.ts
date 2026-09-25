import { expect, test } from "bun:test";
import { z } from "zod";
import { CollectionDegradedError } from "../src/events/store.js";
import { SourceError } from "../src/failure.js";
import { classifyFailure } from "../src/failureDiagnosis.js";
import { nextData } from "../src/sources/html.js";
import { SourceHttpError } from "../src/sources/http.js";
import { parseEachEntry } from "../src/sources/schema.js";

test("a message is trusted because of its type, never because of its first word", () => {
  // The defect this replaces. The old rule was a regular expression anchored on the first word, so
  // an error that began "Source " was stored verbatim whatever followed it -- and what followed it
  // was sometimes the upstream's answer, which is why the body of a failed read is never stored.
  const leak = new Error('Source returned {"redirect":"https://cdn.example.test/x?X-Amz-Signature=deadbeefsecret"}');
  const leaked = classifyFailure(leak);
  expect(leaked.message).not.toContain("deadbeefsecret");
  expect(leaked.message).toBe("Collection failed: unexpected error (Error)");
  expect(leaked.kind).toBe("unknown");

  // The same sentence, declared rather than guessed at, keeps its diagnosis.
  const declared = classifyFailure(new SourceError("bot-protection", "Source challenged by bot protection"));
  expect(declared.kind).toBe("bot-protection");
  expect(declared.message).toBe("Source challenged by bot protection");
});

test("a collector wording a new failure differently keeps its kind", () => {
  // Under the old rule this sentence matched nothing and was filed as "unexpected error", which is
  // the report saying only that there was a report.
  const diagnosis = classifyFailure(new SourceError("missing-content", "The pricing table has no rows"));
  expect(diagnosis.kind).toBe("missing-content");
  expect(diagnosis.message).toBe("The pricing table has no rows");
});

test("every failure that carries structure of its own is classified from the type", () => {
  expect(classifyFailure(new CollectionDegradedError("arena", 1083, 301))).toMatchObject({
    kind: "degraded",
    evidence: { previousCount: 1083, retainedCount: 301 },
  });
  expect(classifyFailure(new SourceHttpError("Source returned HTTP 404", null, 404)).kind).toBe("http");
  expect(classifyFailure(new SourceHttpError("Source returned HTTP 401", null, 401)).kind).toBe("credential");
  expect(
    classifyFailure(new SourceHttpError("Source returned HTTP 429", "2026-09-25T00:00:00.000Z", 429, true)).kind,
  ).toBe("rate-limited");
  const busy = Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY" });
  expect(classifyFailure(busy).kind).toBe("database");
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  expect(classifyFailure(reset).kind).toBe("network");
  expect(classifyFailure(new TypeError("undefined is not an object")).kind).toBe("collector-bug");
});

test("a schema failure records which field complained and how often, and no value from it", () => {
  const parsed = z
    .array(
      z.object({
        displayName: z.string(),
        capabilities: z.object({ outputCapabilities: z.record(z.string(), z.unknown()) }),
      }),
    )
    .safeParse([
      { displayName: "one", capabilities: { outputCapabilities: {} } },
      { displayName: 7, capabilities: { outputCapabilities: {} }, apiKey: "sk-live-do-not-store" },
      { displayName: "three" },
    ]);
  expect(parsed.success).toBe(false);
  const diagnosis = classifyFailure(parsed.error);
  expect(diagnosis.kind).toBe("schema");
  const serialized = JSON.stringify(diagnosis.evidence);
  expect(serialized).not.toContain("sk-live-do-not-store");
  // An array index is reduced to `#`: which of a thousand rows it was tells nobody anything, and the
  // field path is the answer the report could not give.
  expect(serialized).toContain("#.displayName");
  expect(serialized).toContain("#.capabilities");
});

test("entry-wise validation names how many entries failed on which field", () => {
  const entry = z.object({ id: z.string(), rank: z.number() });
  const good = [
    { id: "a", rank: 1 },
    { id: "b", rank: 2 },
  ];
  expect(parseEachEntry(entry, good, "board")).toEqual(good);

  const mixed = [...good, { id: "c" }, { id: "d" }, { rank: 9 }];
  let thrown: unknown;
  try {
    parseEachEntry(entry, mixed, "board");
  } catch (error) {
    thrown = error;
  }
  const diagnosis = classifyFailure(thrown);
  expect(diagnosis.kind).toBe("schema");
  // The sentence `flaky` and `issues` print now carries the answer instead of the word "ZodError".
  expect(diagnosis.message).toBe("board: 3 of 5 entries did not match the schema (rank in 2, id in 1)");
  expect(diagnosis.evidence).toMatchObject({ entries: 5, accepted: 2, rejected: 3 });
});

test("a list that is not a list, and a list with nothing in it, are different failures", () => {
  const entry = z.object({ id: z.string() });
  expect(() => parseEachEntry(entry, { id: "a" }, "board")).toThrow("board is not a list of entries");
  expect(
    classifyFailure(
      (() => {
        try {
          parseEachEntry(entry, [], "board");
          return null;
        } catch (error) {
          return error;
        }
      })(),
    ).kind,
  ).toBe("empty");
});

test("a key present in the page but holding nothing is a missing page, not a broken reader", () => {
  // The measured cause of arena's schema failures. React Flight writes the value `undefined` as the
  // string "$undefined", and arena.ai sends exactly that whenever it renders without the roster.
  // Reading the placeholder as data made the parse fail with "response did not match the schema",
  // which accuses the reader instead of reporting that the page did not carry it.
  const flight = (payload: string) => `<script>self.__next_f.push([1,${JSON.stringify(`0:${payload}\n`)}])</script>`;
  const absent = flight(JSON.stringify({ initialModels: "$undefined" }));
  const diagnosis = classifyFailure(
    (() => {
      try {
        nextData(absent, "initialModels");
        return null;
      } catch (error) {
        return error;
      }
    })(),
  );
  expect(diagnosis.kind).toBe("missing-content");
  expect(diagnosis.message).toBe("Public page no longer exposes initialModels");

  // And the real value is still found, including when the placeholder is somewhere else in the page.
  const present = flight(JSON.stringify({ other: "$undefined", initialModels: [{ id: "a" }] }));
  expect(nextData(present, "initialModels")).toEqual([{ id: "a" }]);
});
