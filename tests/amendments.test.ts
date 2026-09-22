import { expect, test } from "bun:test";
import { applyCardAmendments, outageLength, queueIncidentAmendments } from "../src/amendments.js";
import type { Destination } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";

const wire: Destination = { id: "wire", platform: "discord", channelId: "77", signals: ["launch"] };

test("a major outage's card is edited to say it ended, once, without a new message", async () => {
  const db = openDatabase(":memory:");
  const status = (stage: string): Collection => ({
    source: "status:openai",
    stream: "incidents",
    url: "https://status.openai.com",
    raw: [],
    resolveMissing: true,
    records: [
      { id: "anchor", name: "Earlier", impact: "none", stage: "resolved" },
      ...(stage
        ? [
            {
              id: "01M2KQNE5C42NEZPX6V01NHH5W",
              name: "Elevated errors",
              impact: "major",
              stage,
              components: ["ChatGPT"],
            },
          ]
        : []),
    ],
  });
  saveCollection(db, status(""), [wire], "2026-09-15T23:40:00.000Z");
  saveCollection(db, status("investigating"), [wire], "2026-09-15T23:53:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-15T23:54:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='123456'").run();
  saveCollection(db, status("resolved"), [wire], "2026-09-16T00:40:00.000Z");

  expect(queueIncidentAmendments(db, Date.parse("2026-09-16T00:41:00.000Z"))).toBe(1);
  expect(queueIncidentAmendments(db, Date.parse("2026-09-16T00:42:00.000Z"))).toBe(0);

  const calls: { url: string; method: string | undefined; body: Record<string, unknown> }[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "123456" });
  };
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("PATCH");
  expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/77/messages/123456");
  const embed = (calls[0]?.body.embeds as Record<string, unknown>[] | undefined)?.[0];
  expect(String(embed?.title)).toStartWith("✅ Fixed · ");
  expect(String(embed?.description)).toStartWith("Working again after 47 min.");
  expect(calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);
  db.close();
});

test("a Telegram post about an outage is edited too, while it is less than a day old", async () => {
  const db = openDatabase(":memory:");
  const news: Destination = { id: "tg", platform: "telegram", chatId: "-100", topicId: 5, signals: ["launch"] };
  const status = (stage: string, summary: string): Collection => ({
    source: "status:anthropic",
    stream: "incidents",
    url: "https://status.claude.com",
    raw: [],
    resolveMissing: true,
    records: [
      { id: "anchor", name: "Earlier", impact: "none", stage: "resolved" },
      ...(stage
        ? [
            {
              id: "7g1q",
              name: "Anthropic: Elevated errors on claude.ai",
              impact: "major",
              stage,
              summary,
              started: "2026-09-22T00:57:00.000Z",
              components: ["claude.ai"],
            },
          ]
        : []),
    ],
  });
  saveCollection(db, status("", ""), [news], "2026-09-22T00:50:00.000Z");
  saveCollection(db, status("investigating", "We are investigating."), [news], "2026-09-22T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-22T01:01:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='42',updated_at='2026-09-22T01:02:00.000Z'").run();
  saveCollection(db, status("monitoring", "Success rates are back to normal."), [news], "2026-09-22T05:00:00.000Z");
  saveCollection(db, status("resolved", "This incident has been resolved."), [news], "2026-09-22T06:09:00.000Z");
  expect(queueIncidentAmendments(db, Date.parse("2026-09-22T06:10:00.000Z"))).toBe(1);

  const calls: { url: string; body: Record<string, unknown> }[] = [];
  await applyCardAmendments(db, { TELEGRAM_BOT_TOKEN: "t", destinations: [news] } as never, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.message_id).toBe(42);
  const said = String(calls[0]?.body.text ?? calls[0]?.body.caption);
  expect(said).toContain("Fixed");
  // How long it lasted and the vendor's last real word, not the page's closing formula.
  expect(said).toContain("Working again after 5 h 12 min.");
  expect(said).toContain("Success rates are back to normal.");
  expect(said).not.toContain("This incident has been resolved");
  db.close();
});

test("a Telegram post older than a day is left as it was", () => {
  const db = openDatabase(":memory:");
  const news: Destination = { id: "tg", platform: "telegram", chatId: "-100", signals: ["launch"] };
  const status = (stage: string): Collection => ({
    source: "status:openai",
    stream: "incidents",
    url: "https://status.openai.com",
    raw: [],
    resolveMissing: true,
    records: [
      { id: "anchor", name: "Earlier", impact: "none", stage: "resolved" },
      ...(stage ? [{ id: "x1", name: "ChatGPT down", impact: "major", stage, components: ["ChatGPT"] }] : []),
    ],
  });
  saveCollection(db, status(""), [news], "2026-09-20T00:00:00.000Z");
  saveCollection(db, status("investigating"), [news], "2026-09-20T01:00:00.000Z");
  prepareDeliveries(db, Date.parse("2026-09-20T01:01:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='9',updated_at='2026-09-20T01:02:00.000Z'").run();
  saveCollection(db, status("resolved"), [news], "2026-09-21T12:00:00.000Z");
  expect(queueIncidentAmendments(db, Date.parse("2026-09-21T12:01:00.000Z"))).toBe(0);
  db.close();
});

test("an outage's length reads the way a person says it", () => {
  expect(outageLength(40 * 60_000)).toBe("40 min");
  expect(outageLength(312 * 60_000)).toBe("5 h 12 min");
  expect(outageLength(120 * 60_000)).toBe("2 h");
  expect(outageLength(51 * 3_600_000)).toBe("2 d 3 h");
});
