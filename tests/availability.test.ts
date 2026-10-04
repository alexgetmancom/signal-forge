import { expect, test } from "bun:test";
import { becameReachable, reachableListingSql, unreachableBecause } from "../src/events/availability.js";
import { openDatabase } from "../src/storage/database.js";

test("a listing says whether a reader can call it, and only a listing is asked", () => {
  // Vertex Model Garden, 2026-10-04: 152 rows GA, 63 public preview, 14 experimental, 2 private.
  expect(unreachableBecause("api-models", { id: "x", name: "X", stage: "GA" })).toBeNull();
  expect(unreachableBecause("api-models", { id: "x", name: "X", stage: "PUBLIC_PREVIEW" })).toBeNull();
  expect(unreachableBecause("api-models", { id: "x", name: "X", stage: "EXPERIMENTAL" })).toBeNull();
  expect(unreachableBecause("api-models", { id: "x", name: "X", stage: "PRIVATE_PREVIEW" })).toBe("private_preview");
  // However the catalogue spells it, and whichever field it puts it in.
  expect(unreachableBecause("api-models", { id: "x", name: "X", launchStage: "Private-Preview" })).toBe(
    "private_preview",
  );
  expect(unreachableBecause("api-models", { id: "x", name: "X", availability: "waitlist" })).toBe("waitlist");
  // Weights behind an approval are weights nobody can pull today; `open` and `public` are not.
  expect(unreachableBecause("weights", { id: "x", name: "X", access: "gated" })).toBe("gated");
  expect(unreachableBecause("weights", { id: "x", name: "X", access: "public" })).toBeNull();
  // A field nobody sent is a source that does not answer the question, not a model behind a form.
  expect(unreachableBecause("api-models", { id: "x", name: "X" })).toBeNull();
  // And a newsroom post is not refused by this rule: it is not a listing, so it says nothing either
  // way, and "Elevated errors affecting ChatGPT Work mode" is not a model anybody waits to call.
  expect(unreachableBecause("news", { id: "x", name: "X", stage: "PRIVATE_PREVIEW" })).toBeNull();
});

test("the opening of a listing is a change, and the one change that is an arrival", () => {
  const listing = (stage: string) => JSON.stringify({ id: "gemini-4-argon", name: "Gemini 4 Argon", stage });
  const event = (kind: string, before: string | null, after: string | null) => ({
    stream: "api-models",
    kind,
    before_json: before,
    after_json: after,
  });
  expect(becameReachable(event("changed", listing("PRIVATE_PREVIEW"), listing("GA")))).toBe(true);
  // Closing again is not an arrival, and neither is an edit between two states a reader could call.
  expect(becameReachable(event("changed", listing("GA"), listing("PRIVATE_PREVIEW")))).toBe(false);
  expect(becameReachable(event("changed", listing("GA"), listing("PUBLIC_PREVIEW")))).toBe(false);
  // A row arriving already open is an arrival for the ordinary reason, not for this one.
  expect(becameReachable(event("new", null, listing("GA")))).toBe(false);
  expect(becameReachable(event("changed", "not json", listing("GA")))).toBe(false);
});

test("the vocabulary SQLite applies is the vocabulary the rule applies", () => {
  const db = openDatabase(":memory:");
  // A one-row `WITH`, because the fragment names the column four times and the test is about the
  // fragment the arrivals read uses rather than about how a body gets bound to it.
  const ask = (body: Record<string, unknown>): boolean =>
    Boolean(
      db
        .query<{ ok: number }, [string]>(
          `WITH listing(body) AS (VALUES(?)) SELECT (${reachableListingSql("body")}) AS ok FROM listing`,
        )
        .get(JSON.stringify(body))?.ok,
    );
  for (const body of [{ stage: "GA" }, { stage: "PUBLIC_PREVIEW" }, { access: "public" }, { id: "x", name: "X" }])
    expect([body, ask(body)]).toEqual([body, true]);
  for (const body of [{ stage: "PRIVATE_PREVIEW" }, { launchStage: "private-preview" }, { access: "gated" }])
    expect([body, ask(body)]).toEqual([body, false]);
  db.close();
});
