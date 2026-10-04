import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { SourceError } from "../src/failure.js";
import { classifyFailure } from "../src/failureDiagnosis.js";
import { emptyTraffic } from "../src/runtime/traffic.js";
import { SourceHttpError } from "../src/sources/http.js";
import { type ChildRun, collectInSubprocess, fromWire, readAnswer, toWire } from "../src/sources/subprocess.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";

test("a heavy child uses its parent's database even when the environment names a different file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-forge-child-db-"));
  const db = openDatabase(join(directory, "parent.db"));
  const decoy = openDatabase(join(directory, "decoy.db"));
  const root = "https://learn.chatgpt.com/docs/";
  const index = `[Models](${root}models.md)`;
  const record = { id: `${root}models.md`, name: "Models", url: `${root}models`, strings: ["# Models", "Observed"] };
  try {
    for (const [database, name] of [
      [db, "Models"],
      [decoy, "Wrong"],
    ] as const) {
      const cache = new HttpCache(database);
      for (const [url, body] of [
        [`${root}llms.txt`, `[${name}](${root}${name.toLowerCase()}.md)`],
        [`${root}${name.toLowerCase()}.md`, `# ${name}\n\nObserved`],
      ] as const)
        cache.put(url, { body, etag: null, lastModified: null, freshUntil: Date.now() + 60_000 });
    }
    saveCollection(db, { source: "codex-docs", stream: "web", url: root, records: [record], raw: {} }, []);
    const config = loadConfig({
      CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
      DATABASE_URL: decoy.filename,
    });
    const answer = await collectInSubprocess(db, config, "codex-docs");
    expect(answer.collection.records).toEqual([record]);
    expect(answer.collection.raw).toEqual({ index });
    expect(answer.peakRssMb).toBeGreaterThan(0);
    expect(decoy.query("SELECT count(*) AS n FROM code_metrics").get()).toEqual({ n: 0 });
  } finally {
    db.close();
    decoy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const ran = (over: Partial<ChildRun>): ChildRun => ({
  answer: null,
  peakRssMb: null,
  traffic: null,
  code: 0,
  timedOut: false,
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

test("a child that answers hands back the collection it collected and what it cost", () => {
  const collection = { source: "npm:x", stream: "github", url: "https://x.test", raw: "a", records: [] };
  const got = readAnswer("npm:x", ran({ answer: JSON.stringify({ ok: true, collection }), peakRssMb: 417 }));
  expect(got).toEqual({ collection, peakRssMb: 417, traffic: emptyTraffic() });
  // A child stopped after writing its answer but before writing the measurement has no peak.
  const stopped = readAnswer("npm:x", ran({ answer: JSON.stringify({ ok: true, collection }) }));
  expect(stopped).toEqual({ collection, peakRssMb: null, traffic: emptyTraffic() });
  const unmeasured = readAnswer("npm:x", ran({ answer: JSON.stringify({ ok: true, collection }), peakRssMb: 0 }));
  expect(unmeasured).toEqual({ collection, peakRssMb: null, traffic: emptyTraffic() });
  // A child that counted its network sends the tally home beside the peak, failures included.
  const counted = readAnswer(
    "npm:x",
    ran({
      answer: JSON.stringify({ ok: true, collection }),
      traffic: JSON.stringify({ requests: 3, bytesDecoded: 900, bytesWire: 300, notModified: 1 }),
    }),
  );
  expect(counted.traffic).toEqual({ requests: 3, bytesDecoded: 900, bytesWire: 300, notModified: 1 });
  // A tally that will not parse is no traffic, never a lost collection.
  const babbled = readAnswer("npm:x", ran({ answer: JSON.stringify({ ok: true, collection }), traffic: "{" }));
  expect(babbled.traffic).toEqual(emptyTraffic());
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

test("a failure the child reports is raised in the parent, not swallowed", () => {
  const answer = JSON.stringify({
    ok: false,
    failure: toWire(new SourceError("empty", "models-dev served no models")),
  });
  expect(() => readAnswer("models-dev", ran({ answer }))).toThrow("models-dev served no models");
});
