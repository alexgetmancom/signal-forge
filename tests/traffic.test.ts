import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTraffic, mergeTraffic, readTraffic, withTraffic } from "../src/runtime/traffic.js";
import { fetchText } from "../src/sources/http.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";

const answering = (body: string, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;

test("a collection counts the requests and the bytes it asked for, and nothing outside it does", async () => {
  const { traffic } = await withTraffic(async () => {
    await fetchText("https://x.test/a", {}, answering("hello", { "content-length": "5" }), undefined, undefined, []);
    await fetchText("https://x.test/b", {}, answering("hi"), undefined, undefined, []);
  });
  expect(traffic.requests).toBe(2);
  expect(traffic.bytesDecoded).toBe(7);
  // Only one answer declared a length, so the wire total is that one rather than a guess at both.
  expect(traffic.bytesWire).toBe(5);
  // A request made outside any collection lands in no tally rather than in the previous one: this
  // is what keeps a delivery's own traffic off a source's row.
  await fetchText("https://x.test/c", {}, answering("loose"), undefined, undefined, []);
  expect(traffic.bytesDecoded).toBe(7);
});

test("concurrent collections do not pour their bytes into each other", async () => {
  // The whole reason attribution is ambient rather than a counter: the poller runs four of these
  // at once, and a shared counter would credit every byte to whichever finished last.
  const [left, right] = await Promise.all([
    withTraffic(() => fetchText("https://x.test/l", {}, answering("1234"), undefined, undefined, [])),
    withTraffic(() => fetchText("https://x.test/r", {}, answering("123456789"), undefined, undefined, [])),
  ]);
  expect(left.traffic.bytesDecoded).toBe(4);
  expect(right.traffic.bytesDecoded).toBe(9);
});

test("an answer that carried no body is counted as asked and not as downloaded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "traffic-"));
  const db = openDatabase(join(directory, "app.db"));
  try {
    const cache = new HttpCache(db);
    const request = (async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).get("if-none-match")
        ? new Response(null, { status: 304 })
        : new Response("body", { status: 200, headers: { etag: "v1" } })) as unknown as typeof fetch;
    const { traffic } = await withTraffic(async () => {
      await fetchText("https://x.test/p", {}, request, undefined, cache, []);
      await fetchText("https://x.test/p", {}, request, undefined, cache, []);
    });
    expect(traffic.requests).toBe(2);
    expect(traffic.notModified).toBe(1);
    // The second ask cost a round trip and no body, which is the difference between a source that
    // is quiet because its cache works and one that is quiet because it stopped collecting.
    expect(traffic.bytesDecoded).toBe(4);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a tally read back from a child keeps only whole counts", () => {
  expect(readTraffic('{"requests":2,"bytesDecoded":10,"bytesWire":4,"notModified":1}')).toEqual({
    requests: 2,
    bytesDecoded: 10,
    bytesWire: 4,
    notModified: 1,
  });
  // A number that is not a count is dropped rather than stored: a negative or fractional byte
  // total would be summed into a day and could never be told from a real one afterwards.
  expect(readTraffic('{"requests":-3,"bytesDecoded":1.5}')).toEqual(emptyTraffic());
  expect(readTraffic("not json")).toBeNull();
  expect(mergeTraffic(emptyTraffic(), { requests: 1, bytesDecoded: 2, bytesWire: 3, notModified: 4 })).toEqual({
    requests: 1,
    bytesDecoded: 2,
    bytesWire: 3,
    notModified: 4,
  });
});
