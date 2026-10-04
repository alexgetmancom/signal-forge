import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { traffic as reportTraffic } from "../src/reports/traffic.js";
import { emptyTraffic, mergeTraffic, readTraffic, withTraffic } from "../src/runtime/traffic.js";
import { fetchText, readResponseBytes, readResponseStream } from "../src/sources/http.js";
import { foldCollectionDays } from "../src/storage/collectionDays.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { pruneSourceTraffic } from "../src/storage/retention.js";
import { recordTraffic } from "../src/storage/sourceTraffic.js";
import { anAttempt, aSource } from "./fixtures/build.js";

const answering = (body: string, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;

test("missing body lengths remain unknown and requests outside a collection add nothing", async () => {
  const traffic = emptyTraffic();
  await withTraffic(traffic, async () => {
    await fetchText("https://x.test/a", {}, answering("hello", { "content-length": "5" }), undefined, undefined, []);
    await fetchText("https://x.test/b", {}, answering("hi"), undefined, undefined, []);
  });
  expect(traffic).toEqual({
    requests: 2,
    bodyReads: 2,
    bytesDecoded: 7,
    bytesWire: null,
    notModified: 0,
    cacheHits: 0,
  });
  await fetchText("https://x.test/c", {}, answering("loose"), undefined, undefined, []);
  expect(traffic.bytesDecoded).toBe(7);
});

test("concurrent collections keep separate counts even when one fails after reading", async () => {
  const left = emptyTraffic(),
    right = emptyTraffic();
  await Promise.allSettled([
    withTraffic(left, async () => {
      await fetchText("https://x.test/l", {}, answering("1234"), undefined, undefined, []);
      throw new Error("after reading");
    }),
    withTraffic(right, () => fetchText("https://x.test/r", {}, answering("123456789"), undefined, undefined, [])),
  ]);
  expect(left.bytesDecoded).toBe(4);
  expect(right.bytesDecoded).toBe(9);
});

test("304s and fresh cache hits count separately from actual body reads", async () => {
  const db = openDatabase(":memory:");
  try {
    const cache = new HttpCache(db);
    const request = (async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).get("if-none-match")
        ? new Response(null, { status: 304, headers: { "cache-control": "max-age=600, immutable" } })
        : new Response("body", {
            status: 200,
            headers: { etag: "v1", "content-length": "4" },
          })) as unknown as typeof fetch;
    const traffic = emptyTraffic();
    await withTraffic(traffic, async () => {
      for (let i = 0; i < 3; i++) await fetchText("https://x.test/p.js", {}, request, undefined, cache, []);
    });
    expect(traffic).toEqual({ requests: 2, bodyReads: 1, bytesDecoded: 4, bytesWire: 4, notModified: 1, cacheHits: 1 });
  } finally {
    db.close();
  }
});

test("a failed transport counts every retry rather than discarding the held tally", async () => {
  const traffic = emptyTraffic();
  const request = (async () => {
    throw new TypeError("unreachable");
  }) as unknown as typeof fetch;
  await expect(
    withTraffic(traffic, () => fetchText("https://x.test", {}, request, undefined, undefined, [0, 0])),
  ).rejects.toThrow("could not be reached");
  expect(traffic.requests).toBe(3);
});

test("streamed bytes remain counted when a body fails or is cancelled", async () => {
  const traffic = emptyTraffic();
  await withTraffic(traffic, async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(11));
        } else controller.error(new Error("broken"));
      },
    });
    await expect(readResponseBytes(new Response(broken))).rejects.toThrow("body could not be read");
    const reader = readResponseStream(new Response("hello", { headers: { "content-length": "5" } })).getReader();
    await reader.read();
    await reader.cancel();
  });
  expect(traffic.bodyReads).toBe(2);
  expect(traffic.bytesDecoded).toBe(16);
  expect(traffic.bytesWire).toBeNull();
});

test("child counts require the complete current shape and propagate unknown lengths", () => {
  const tally = { requests: 2, bodyReads: 1, bytesDecoded: 10, bytesWire: null, notModified: 1, cacheHits: 0 };
  expect(readTraffic(JSON.stringify(tally))).toEqual(tally);
  expect(readTraffic('{"requests":-3,"bytesDecoded":1.5}')).toBeNull();
  expect(readTraffic(JSON.stringify({ ...tally, requests: -3 }))).toBeNull();
  expect(readTraffic("not json")).toBeNull();
  expect(mergeTraffic(emptyTraffic(), tally)).toEqual(tally);
});

test("traffic uses its measured output and elapsed window, and survives refolding collections", () => {
  const db = openDatabase(":memory:");
  const at = "2026-10-04T12:00:00.000Z";
  const now = Date.parse("2026-10-04T18:00:00.000Z");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  try {
    aSource(db, "vercel-gateway", { checkedAt: at, lastSuccess: at });
    aSource(db, "openrouter", { checkedAt: at, lastSuccess: at });
    // Output from before measurement must not improve the measured download's ratio.
    anAttempt(db, "openrouter", null, at, { events: 99 });
    const tally = { requests: 4, bodyReads: 2, bytesDecoded: 1000, bytesWire: 500, notModified: 1, cacheHits: 3 };
    recordTraffic(db, "openrouter", at, tally, 10, 2);
    recordTraffic(db, "openrouter", "2026-10-04T13:00:00.000Z", { ...emptyTraffic(), requests: 1 });
    recordTraffic(db, "vercel-gateway", at, emptyTraffic());
    foldCollectionDays(db, now);
    const report = reportTraffic(db, config, 7, now);
    const source = report.sources.find((source) => source.id === "openrouter");
    expect(source).toMatchObject({
      attempts: 2,
      requests: 5,
      requestsPerDay: 20,
      bytesPerDay: 4000,
      bytesPerEvent: 500,
      bytesPerRecord: 100,
      averageBodyBytes: 500,
      notModifiedShare: 0.2,
      cacheHits: 3,
      events: 2,
    });
    expect(report.measuredSince).toBe(at);
    expect(report.totals.events).toBe(2);
    expect(report.unmeasured).not.toContain("vercel-gateway");
    expect(report.sources.find((source) => source.id === "vercel-gateway")?.requests).toBe(0);
    recordTraffic(db, "openrouter", "2026-10-04T14:00:00.000Z", { ...tally, bytesWire: null }, 10, 0);
    expect(
      reportTraffic(db, config, 7, now).sources.find((source) => source.id === "openrouter")?.bytesWire,
    ).toBeNull();
    recordTraffic(db, "openrouter", "2026-01-01T00:00:00.000Z", tally);
    expect(pruneSourceTraffic(db, now)).toBe(1);
    expect(reportTraffic(db, config, 7, now).totals.events).toBe(2);
  } finally {
    db.close();
  }
});
