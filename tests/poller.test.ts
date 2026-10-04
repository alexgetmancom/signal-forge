import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { unexplainedFailure } from "../src/failureDiagnosis.js";
import { byLongestWait, collectNamedSource } from "../src/poller.js";
import { sourceJobs } from "../src/sources/registry.js";
import { foldCollectionDays } from "../src/storage/collectionDays.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { storeSnapshot } from "../src/storage/snapshots.js";
import { aRecord, aSource } from "./fixtures/build.js";

const pollerConfig = () => loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });

test("models.dev's unchanged check runs before its heavy child and continues to mark success", async () => {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const instant = Date.now() - 1000;
  cache.put(
    "https://models.dev/api.json",
    { body: "unused", etag: '"same"', lastModified: null, freshUntil: 0 },
    instant - 1000,
  );
  aSource(db, "models-dev", { lastSuccess: new Date(instant).toISOString() });
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (url, init) => {
    requests++;
    expect(String(url)).toBe("https://models.dev/api.json");
    expect(init?.method).toBe("HEAD");
    return new Response(null, { status: 304 });
  }) as typeof fetch;
  try {
    const config = pollerConfig();
    expect(await collectNamedSource(db, config, "models-dev")).toMatchObject({ status: "unchanged" });
    expect(await collectNamedSource(db, config, "models-dev")).toMatchObject({ status: "unchanged" });
    expect(requests).toBe(2);
    foldCollectionDays(db);
    expect(
      db.query("SELECT attempts,requests,not_modified FROM source_traffic_days WHERE source='models-dev'").get(),
    ).toEqual({ attempts: 2, requests: 2, not_modified: 2 });
    expect(db.query("SELECT count(*) AS n FROM snapshots").get()).toEqual({ n: 0 });
    expect(
      db
        .query("SELECT failures,last_error,last_success=checked_at AS healthy FROM sources WHERE id='models-dev'")
        .get(),
    ).toEqual({ failures: 0, last_error: null, healthy: 1 });
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});

test("Codex RSS and npm finish an unchanged check without starting their heavy child", async () => {
  for (const source of ["openai-codex-changelog", "npm:@openai/codex"]) {
    const db = openDatabase(":memory:");
    const at = Date.now() - 1000;
    aSource(db, source, { lastSuccess: new Date(at).toISOString() });
    if (source.startsWith("npm:"))
      aRecord(db, { source, id: "latest", body: { id: "latest", name: "Codex", version: "1.2.3" } });
    else
      new HttpCache(db).put(
        "https://learn.chatgpt.com/docs/changelog/rss.xml",
        { body: "not XML", etag: '"same"', lastModified: null, freshUntil: 0 },
        at - 1000,
      );
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async (_url, init) => {
      requests++;
      if (source.startsWith("npm:")) return Response.json({ latest: "1.2.3" });
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const child = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("unexpected child");
    });
    try {
      expect(await collectNamedSource(db, pollerConfig(), source)).toMatchObject({ status: "unchanged" });
      expect(requests).toBe(1);
      expect(child).not.toHaveBeenCalled();
      expect(db.query("SELECT count(*) AS n FROM snapshots").get()).toEqual({ n: 0 });
      expect(db.query("SELECT last_success=checked_at AS healthy FROM sources WHERE id=?").get(source)).toEqual({
        healthy: 1,
      });
    } finally {
      child.mockRestore();
      globalThis.fetch = original;
      db.close();
    }
  }
});

test("an unchanged source still collects to settle a pending disappearance or change", async () => {
  for (const field of ["missing_count", "candidate_body"]) {
    const db = openDatabase(":memory:");
    const at = Date.now() - 1000;
    aSource(db, "models-dev", { lastSuccess: new Date(at).toISOString() });
    aRecord(db, { source: "models-dev", id: "pending" });
    if (field === "missing_count") db.query("UPDATE records SET missing_count=1 WHERE source='models-dev'").run();
    else db.query("UPDATE records SET candidate_body='{}' WHERE source='models-dev'").run();
    new HttpCache(db).put(
      "https://models.dev/api.json",
      { body: "unused", etag: '"same"', lastModified: null, freshUntil: 0 },
      at - 1000,
    );
    const child = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("child was reached");
    });
    try {
      expect(await collectNamedSource(db, pollerConfig(), "models-dev")).toMatchObject({ status: "failed" });
      expect(child).toHaveBeenCalledTimes(1);
    } finally {
      child.mockRestore();
      db.close();
    }
  }
});

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

test("collecting one named source refuses a name the registry does not have, and waits out a Retry-After", async () => {
  const db = openDatabase(":memory:");
  const config = pollerConfig();
  await expect(collectNamedSource(db, config, "openai-prcing")).rejects.toThrow("is not a source this deployment");
  const source = sourceJobs(db, config)[0]?.id as string;
  aSource(db, source, { retryAt: new Date(Date.now() + 600_000).toISOString() });
  // Even an operator's forced collection honours the wait the server set for itself.
  expect(await collectNamedSource(db, config, source)).toMatchObject({ source, status: "deferred" });
  db.close();
});

test("a malformed response still records the network spent before collection failed", async () => {
  const db = openDatabase(":memory:");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not json!")) as unknown as typeof fetch;
  try {
    expect(await collectNamedSource(db, pollerConfig(), "vercel-gateway")).toMatchObject({ status: "failed" });
    expect(
      db
        .query("SELECT attempts,requests,body_reads,bytes_decoded,bytes_wire,events_created FROM source_traffic_days")
        .get(),
    ).toEqual({ attempts: 1, requests: 1, body_reads: 1, bytes_decoded: 9, bytes_wire: null, events_created: 0 });
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});

test("an unchanged Google child index skips the heavy sitemap process and counts its small probe", async () => {
  const db = openDatabase(":memory:");
  const original = globalThis.fetch;
  const at = "2026-10-03T05:05:57.000Z";
  const url = "https://ai.google.dev/sitemap_0_of_1.xml";
  aSource(db, "pages:google", { lastSuccess: at });
  storeSnapshot(db, "pages:google", at, JSON.stringify({ pages: 637, sitemaps: [{ url, modified: at }] }));
  const body = `<sitemapindex><sitemap><loc>${url}</loc><lastmod>${at}</lastmod></sitemap></sitemapindex>`;
  globalThis.fetch = (async (asked) => {
    expect(String(asked)).toBe("https://ai.google.dev/sitemap.xml");
    return new Response(body);
  }) as typeof fetch;
  const child = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("unexpected child");
  });
  try {
    expect(await collectNamedSource(db, pollerConfig(), "pages:google")).toMatchObject({ status: "unchanged" });
    expect(child).not.toHaveBeenCalled();
    expect(
      db.query("SELECT requests,bytes_decoded FROM source_traffic_days WHERE source='pages:google'").get(),
    ).toEqual({ requests: 1, bytes_decoded: Buffer.byteLength(body) });
  } finally {
    child.mockRestore();
    globalThis.fetch = original;
    db.close();
  }
});
