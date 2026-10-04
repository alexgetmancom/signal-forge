import { expect, spyOn, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { acceptedEtagUnchanged } from "../src/sources/http.js";
import { collectOpenCodeData } from "../src/sources/opencodeData.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { aSource } from "./fixtures/build.js";

const catalogueUrl = "https://models.opencode.ai/models.json";
const models = {
  "moonshotai/kimi-k3": { id: "moonshotai/kimi-k3", name: "Kimi K3", release_date: "2026-07-16" },
  "alibaba/qwen3.8-max-prime": {
    id: "alibaba/qwen3.8-max-prime",
    name: "Qwen 3.8 Max Prime",
    release_date: "2026-09-23",
    benchmarks: [{ name: "DesignArena", score: 1300 }],
    license: "Apache-2.0",
    future_field: { target: "next-alias", expires: "2027-01-01" },
  },
  "writer/palmyra-x5": { id: "writer/palmyra-x5", name: "Palmyra X5" },
};

test("one canonical response keeps every followed model and the full upstream metadata", async () => {
  const seen: string[] = [];
  const collection = await collectOpenCodeData(async (url) => {
    seen.push(String(url));
    return Response.json(models);
  });
  expect(seen).toEqual([catalogueUrl]);
  expect(collection.records.map((record) => record.id)).toEqual(["moonshotai/kimi-k3", "alibaba/qwen3.8-max-prime"]);
  expect(collection.records[1]).toMatchObject({
    url: "https://opencode.ai/data/alibaba/qwen3-8-max-prime",
    created: "2026-09-23",
    maker: "alibaba",
    source: "opencode-data",
  });
  expect(collection.raw).toEqual(models);
});

test("dates keep their precision and never spill into the next model", async () => {
  const collection = await collectOpenCodeData(async () =>
    Response.json({
      "upstage/solar-pro3": { id: "upstage/solar-pro3", name: "Solar Pro 3", release_date: "2026-01" },
      "upstage/undated": { id: "upstage/undated", name: "Undated" },
      "upstage/solar-pro2": { id: "upstage/solar-pro2", name: "Solar Pro 2", release_date: "2025-05-20" },
      "deepseek/deepseek-v4-flash-0731": {
        id: "deepseek/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash 0731",
        release_date: "2026-07-31",
      },
    }),
  );
  expect(collection.records.map((record) => record.created)).toEqual([
    "2026-01",
    undefined,
    "2025-05-20",
    "2026-07-31",
  ]);
  // The stats JSON aliases this dated release to the April model; the catalogue's id preserves its own page.
  expect(collection.records[3]?.url).toBe("https://opencode.ai/data/deepseek/deepseek-v4-flash-0731");
});

test("a lab this repository does not follow is left out, and the catalogue is the only thing asked", async () => {
  const seen: string[] = [];
  const collection = await collectOpenCodeData(async (url) => {
    seen.push(String(url));
    return Response.json({
      ...models,
      // An undisclosed lab and a real one nobody here follows are the same case: neither is probed
      // separately, and a name nobody has listed reaches us from a source that publishes one.
      "unknown/space-bunny": { id: "unknown/space-bunny", name: "Space Bunny" },
      "vispark/muse-spark-2": { id: "vispark/muse-spark-2", name: "Muse Spark 2" },
    });
  });
  expect(seen).toEqual([catalogueUrl]);
  expect(collection.records.some((model) => model.id.startsWith("unknown/"))).toBe(false);
  expect(collection.records.some((model) => model.id.startsWith("vispark/"))).toBe(false);
  expect(collection.records.length).toBeGreaterThan(0);
});

test("a refused, empty or malformed catalogue fails the entire observation", async () => {
  await expect(collectOpenCodeData(async () => new Response(null, { status: 404 }))).rejects.toMatchObject({
    status: 404,
  });
  await expect(collectOpenCodeData(async () => new Response("<html>sign in</html>"))).rejects.toMatchObject({
    kind: "schema",
  });
  for (const body of [
    {},
    { "google/gemini": { name: "Gemini" } },
    { "google/gemini": { id: "google/other", name: "Gemini" } },
  ])
    await expect(collectOpenCodeData(async () => Response.json(body))).rejects.toThrow();
  await expect(
    collectOpenCodeData(async () => Response.json({ "writer/palmyra": { id: "writer/palmyra", name: "Palmyra" } })),
  ).rejects.toMatchObject({ kind: "empty" });
});

function acceptedCache() {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const acceptedAt = "2026-10-04T08:00:00.000Z";
  aSource(db, "discovery:opencode-data", { lastSuccess: acceptedAt });
  cache.put(
    catalogueUrl,
    { body: JSON.stringify(models), etag: 'W/"accepted"', lastModified: null, freshUntil: 0 },
    Date.parse(acceptedAt) - 1000,
  );
  return { db, cache, acceptedAt };
}

test("an accepted 304 bypasses decoding and the registry collects OpenCode without a child", async () => {
  const { db, cache } = acceptedCache();
  const get = spyOn(cache, "get");
  const head = async (...[url, init]: Parameters<typeof fetch>) => {
    expect(String(url)).toBe(catalogueUrl);
    expect(init?.method).toBe("HEAD");
    expect(new Headers(init?.headers).get("if-none-match")).toBe('W/"accepted"');
    return new Response(null, { status: 304 });
  };
  const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(head, { preconnect: fetch.preconnect }));
  try {
    const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
    const source = buildSourceRegistry(db, config).find((job) => job.id === "discovery:opencode-data");
    expect(source?.heavy).not.toBe(true);
    expect(await source?.nothingNew?.()).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
    get.mockRestore();
    db.close();
  }
});

test("a cache write newer than the last accepted collection, or a failed source, cannot hide a collection", async () => {
  const { db, cache, acceptedAt } = acceptedCache();
  let asked = 0;
  const request = async () => {
    asked++;
    return new Response(null, { status: 304 });
  };
  cache.put(
    catalogueUrl,
    { body: "unaccepted", etag: '"new"', lastModified: null, freshUntil: 0 },
    Date.parse(acceptedAt) + 1000,
  );
  expect(await acceptedEtagUnchanged(db, cache, "discovery:opencode-data", catalogueUrl, request)).toBe(false);
  cache.put(
    catalogueUrl,
    { body: "accepted", etag: '"old"', lastModified: null, freshUntil: 0 },
    Date.parse(acceptedAt) - 1000,
  );
  aSource(db, "discovery:opencode-data", { lastSuccess: acceptedAt, failures: 1 });
  expect(await acceptedEtagUnchanged(db, cache, "discovery:opencode-data", catalogueUrl, request)).toBe(false);
  expect(asked).toBe(0);
  db.close();
});

test("a changed ETag fetches the complete replacement, and a refusal preserves rate-limit backoff", async () => {
  const { db, cache } = acceptedCache();
  const request = async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe(catalogueUrl);
    return init?.method === "HEAD"
      ? new Response(null, { status: 200 })
      : Response.json(models, { headers: { etag: '"new"' } });
  };
  expect(await acceptedEtagUnchanged(db, cache, "discovery:opencode-data", catalogueUrl, request)).toBe(false);
  expect((await collectOpenCodeData(request, cache)).raw).toEqual(models);
  expect(cache.get(catalogueUrl)?.etag).toBe('"new"');
  // The cache has moved but no successful pipeline save has followed it yet.
  expect(
    await acceptedEtagUnchanged(
      db,
      cache,
      "discovery:opencode-data",
      catalogueUrl,
      async () => new Response(null, { status: 304 }),
    ),
  ).toBe(false);
  const accepted = acceptedCache();
  await expect(
    acceptedEtagUnchanged(
      accepted.db,
      accepted.cache,
      "discovery:opencode-data",
      catalogueUrl,
      async () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    ),
  ).rejects.toMatchObject({ status: 429, rateLimited: true, retryAt: expect.any(String) });
  accepted.db.close();
  db.close();
});
