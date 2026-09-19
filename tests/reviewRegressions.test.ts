import { expect, test } from "bun:test";
import { publishAlerts } from "../src/alerts.js";
import { loadConfig } from "../src/config.js";
import { persistCollection } from "../src/events/store.js";
import type { Collection } from "../src/events/types.js";
import { parseDeepSeekPricing, parseDeepSeekUpdates } from "../src/sources/deepseek.js";
import { calendarDate, parseAnthropicSdkReleases, parseOfficialFeed } from "../src/sources/feeds.js";
import { fetchText, SourceHttpError } from "../src/sources/http.js";
import { openDatabase } from "../src/storage/database.js";
import { expireSnapshotBodies } from "../src/storage/retention.js";
import { readLatestSnapshot, storeSnapshot } from "../src/storage/snapshots.js";
import { clip } from "../src/text.js";

test("a record that returns changed between two misses is not reported gone", () => {
  const db = openDatabase(":memory:");
  const base = { source: "t", stream: "openrouter", url: "u", raw: {}, confirmChanges: true } as const;
  const row = (id: string, v = 1) => ({ id, name: id, v });
  const others = [row("a"), row("b"), row("c")];
  const poll = (records: Collection["records"], at: string) =>
    persistCollection(db, { ...base, records } as Collection, [], at);
  poll([row("x"), ...others], "2026-01-01T00:00:00.000Z");
  poll([row("x"), ...others], "2026-01-01T01:00:00.000Z");
  poll(others, "2026-01-01T02:00:00.000Z");
  poll([row("x", 2), ...others], "2026-01-01T03:00:00.000Z");
  poll(others, "2026-01-01T04:00:00.000Z");
  expect(db.query("SELECT kind FROM events WHERE entity_id='x'").all()).toEqual([]);
  db.close();
});

test("a snapshot whose body was released is stored again when the same bytes return", () => {
  const db = openDatabase(":memory:");
  const raw = JSON.stringify({ indicator: "none", headline: "All Systems Operational" });
  storeSnapshot(db, "status:openai", "2026-01-01T00:00:00.000Z", raw);
  expireSnapshotBodies(db, Date.parse("2026-04-15T00:00:00.000Z"));
  storeSnapshot(db, "status:openai", "2026-04-15T00:05:00.000Z", raw);
  expect(readLatestSnapshot(db, "status:openai")).toBe(raw);
  db.close();
});

test("an alert that failed to post does not wedge the channel when the problems move on", async () => {
  const db = openDatabase(":memory:");
  const config = {
    ...loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    DISCORD_BOT_TOKEN: "token",
    alertChannelId: "999",
  };
  let fail = true;
  const request = async () => (fail ? new Response("down", { status: 500 }) : Response.json({ id: "1" }));
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const mark = (id: string) =>
    db
      .query(
        "INSERT INTO sources(id,last_error,last_success,checked_at) VALUES(?,'Source returned HTTP 500',NULL,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, new Date(now).toISOString());
  mark("openrouter");
  await publishAlerts(db, config, request, now);
  mark("models-dev");
  expect((await publishAlerts(db, config, request, now)).posted).toBe(false);
  fail = false;
  const recovered = await publishAlerts(db, config, request, now);
  expect(recovered.posted).toBe(true);
  expect(recovered.down.sort()).toEqual(["models-dev", "openrouter"]);
  db.close();
});

test("GitHub's rate-limit 403 is a rate limit, not a refused credential", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const request = async () =>
    new Response("limit", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
  const error = await fetchText("https://api.github.com/x", {}, request, undefined, undefined, []).catch((e) => e);
  expect(error).toBeInstanceOf(SourceHttpError);
  expect(error.rateLimited).toBe(true);
  expect(Date.parse(error.retryAt)).toBeGreaterThan(reset * 1000);
  const refused = await fetchText(
    "https://api.github.com/x",
    {},
    async () => new Response("", { status: 403 }),
    undefined,
    undefined,
    [],
  ).catch((e) => e);
  expect(refused.rateLimited).toBe(false);
});

test("a 304 with no cached body asks again without validators", async () => {
  let asks = 0;
  const request = async () => (++asks === 1 ? new Response(null, { status: 304 }) : new Response("fresh"));
  expect(await fetchText("https://example.com/", {}, request, undefined, undefined, [])).toBe("fresh");
  expect(asks).toBe(2);
});

test("a written day is that day in UTC whatever zone the host runs in", () => {
  for (const written of ["September 15, 2026", "15 September 2026", "Sept 15, 2026"])
    expect(calendarDate(written)?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  expect(calendarDate("Mon, 15 Sep 2026 10:00:00 GMT")?.toISOString()).toBe("2026-09-15T10:00:00.000Z");
});

test("an SDK release section keeps its id when its text is edited", () => {
  const page = (text: string) => `### September 15, 2026\n\n${text}\n\n### September 10, 2026\n\nOlder.\n`;
  const before = parseAnthropicSdkReleases(page("We launched a thing."));
  const after = parseAnthropicSdkReleases(page("Added first: a second thing.\n\nWe launched a thing."));
  expect(after.records.map((record) => record.id)).toEqual(before.records.map((record) => record.id));
});

test("DeepSeek pricing reads every feature, plain prices, and ids without footnotes", () => {
  const html = `<table>
<tr><td colspan="3">MODEL</td><td>deepseek-flash (1)</td><td>deepseek-v4-pro<sup>2</sup></td></tr>
<tr><td rowspan="3">FEATURES</td><td colspan="2">JSON Output</td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2">Tool Calls</td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2">FIM Completion</td><td>✓</td><td>✗</td></tr>
<tr><td rowspan="3">PRICING</td><td colspan="2">1M INPUT TOKENS (CACHE HIT)</td><td>$0.028</td><td>$0.028</td></tr>
<tr><td colspan="2">1M INPUT TOKENS (CACHE MISS)</td><td>$0.28</td><td>$0.28</td></tr>
<tr><td colspan="2">1M OUTPUT TOKENS</td><td>$0.42</td><td>$0.42</td></tr>
</table>`;
  const [flash, pro] = parseDeepSeekPricing(html).records;
  expect(flash).toMatchObject({
    id: "deepseek-flash",
    capabilities: ["JSON Output", "Tool Calls", "FIM Completion"],
    pricing: { inputCacheHit: 0.028, inputCacheMiss: 0.28, output: 0.42 },
  });
  expect(pro).toMatchObject({ id: "deepseek-v4-pro", capabilities: ["JSON Output", "Tool Calls"] });
});

test("a DeepSeek update heading with no id and no latin title still parses", () => {
  const parsed = parseDeepSeekUpdates("<article><h2>Date: 2026-08-21</h2><h3>模型更新</h3><p>内容</p></article>");
  expect(parsed.records[0]?.id).toBe("2026-08-21:update-1");
});

test("one malformed feed item is skipped, not the whole feed", () => {
  const feed = `<?xml version="1.0"?><rss><channel>
<item><title>Good</title><link>https://example.com/a</link><pubDate>Mon, 15 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Bad date</title><link>https://example.com/b</link><pubDate>someday</pubDate></item>
</channel></rss>`;
  const parsed = parseOfficialFeed(feed, { source: "test-feed", maker: "Test", url: "https://example.com" });
  expect(parsed.records.map((record) => record.name)).toEqual(["Good"]);
});

test("clipping never leaves half an emoji", () => {
  expect(clip("ab🔴", 3)).toBe("ab");
  expect(clip("ab🔴", 4)).toBe("ab🔴");
});
