import { expect, test } from "bun:test";
import { SourceError } from "../src/failure.js";
import { classifyFailure } from "../src/failureDiagnosis.js";
import { SourceHttpError } from "../src/sources/http.js";
import { type ChildRun, collectInSubprocess, fromWire, readAnswer, toWire } from "../src/sources/subprocess.js";

const ran = (over: Partial<ChildRun>): ChildRun => ({
  answer: null,
  code: 0,
  timedOut: false,
  stderr: "",
  ...over,
});

test("a rate limit crossing the process boundary keeps the time it asked us to come back", () => {
  // Flattened to a message, this is the backoff every heavy source would silently stop honouring.
  const raised = new SourceHttpError("npm refused: HTTP 429", "2026-09-26T21:00:00.000Z", 429, true);
  const again = fromWire(toWire(raised));
  expect(again).toBeInstanceOf(SourceHttpError);
  expect((again as SourceHttpError).retryAt).toBe("2026-09-26T21:00:00.000Z");
  expect((again as SourceHttpError).status).toBe(429);
  expect((again as SourceHttpError).rateLimited).toBe(true);
  expect(classifyFailure(again).kind).toBe("rate-limited");
});

test("a refused credential stays a credential, not a link that dropped", () => {
  const again = fromWire(toWire(new SourceHttpError("GitHub refused", null, 401)));
  expect(classifyFailure(again).kind).toBe("credential");
  expect((again as SourceHttpError).status).toBe(401);
});

test("a collector's own diagnosis and its evidence survive the crossing", () => {
  const raised = new SourceError("schema", "npm document has no dist-tags", { evidence: { missing: 1 } });
  const again = fromWire(toWire(raised));
  expect(again).toBeInstanceOf(SourceError);
  const diagnosis = classifyFailure(again);
  expect(diagnosis.kind).toBe("schema");
  expect(diagnosis.message).toBe("npm document has no dist-tags");
  expect(diagnosis.evidence).toEqual({ missing: 1 });
});

test("a runtime failure keeps the name and the code its diagnosis is read off", () => {
  const raised = Object.assign(new Error("connect ENOTFOUND registry.npmjs.org"), { code: "ENOTFOUND" });
  const again = fromWire(toWire(raised));
  expect(again.name).toBe("Error");
  expect((again as { code?: string }).code).toBe("ENOTFOUND");
  expect(classifyFailure(again).kind).toBe(classifyFailure(raised).kind);
});

test("a child that answers hands back the collection it collected", async () => {
  const collection = { source: "npm:x", stream: "github", url: "https://x.test", raw: "a", records: [] };
  const got = await collectInSubprocess("npm:x", async () => ran({ answer: JSON.stringify({ ok: true, collection }) }));
  expect(got).toEqual(collection);
});

test("a child that dies, times out or babbles is a failure with a kind rather than a silent nothing", () => {
  // Each of these used to be indistinguishable from a source that answered with an empty list,
  // which is the one outcome that must never be read as "the upstream dropped everything".
  expect(() => readAnswer("polymarket", ran({ timedOut: true, code: null }))).toThrow(/did not finish within 300s/);
  expect(() => readAnswer("polymarket", ran({ code: 137 }))).toThrow(/exited with code 137 without answering/);
  expect(() => readAnswer("polymarket", ran({ code: null }))).toThrow(/was killed without answering/);
  expect(() => readAnswer("polymarket", ran({ answer: "not json" }))).toThrow(/not JSON/);
  for (const run of [ran({ timedOut: true, code: null }), ran({ code: 137 }), ran({ answer: "not json" })])
    expect(() => readAnswer("polymarket", run)).toThrow(SourceError);
});

test("a failure the child reports is raised in the parent, not swallowed", async () => {
  const answer = JSON.stringify({
    ok: false,
    failure: toWire(new SourceError("empty", "models-dev served no models")),
  });
  await expect(collectInSubprocess("models-dev", async () => ran({ answer }))).rejects.toThrow(
    "models-dev served no models",
  );
});
