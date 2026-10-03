import { expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { unexplainedFailure } from "../src/failureDiagnosis.js";
import { byLongestWait, collectNamedSource } from "../src/poller.js";
import { sourceJobs } from "../src/sources/registry.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";
import { aSource } from "./fixtures/build.js";

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
