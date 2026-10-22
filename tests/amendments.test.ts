import { expect, test } from "bun:test";
import {
  applyCardAmendments,
  outageLength,
  queueIncidentAmendments,
  queuePriceAmendments,
  queueResetAmendments,
} from "../src/amendments.js";
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

test("a launch card sent before anyone priced the model gains the rate when it arrives", async () => {
  const db = openDatabase(":memory:");
  const maker = (models: Collection["records"]): Collection => ({
    source: "anthropic",
    stream: "api-models",
    url: "https://api.anthropic.com/v1/models",
    raw: [],
    records: models,
  });
  const earlier = { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000 };
  saveCollection(db, maker([earlier]), [wire], "2026-10-07T12:00:00.000Z");
  // 17:51: the maker answers, the card goes out, and no catalogue anywhere holds a price.
  saveCollection(
    db,
    maker([earlier, { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 1_000_000 }]),
    [wire],
    "2026-10-07T17:51:19.499Z",
  );
  prepareDeliveries(db, Date.parse("2026-10-07T17:52:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='123456'").run();
  expect(queuePriceAmendments(db, Date.parse("2026-10-07T17:53:00.000Z"))).toBe(0);

  // 18:13: the maker's own price table catches up, twenty-two minutes behind its own API.
  saveCollection(
    db,
    {
      source: "anthropic-pricing",
      stream: "api-models",
      url: "https://platform.claude.com/docs/en/about-claude/pricing",
      raw: [],
      records: [
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", maker: "Anthropic", pricing: { input: 0.1, output: 0.5 } },
      ],
    },
    [],
    "2026-10-07T18:13:00.000Z",
  );

  expect(queuePriceAmendments(db, Date.parse("2026-10-07T18:14:00.000Z"))).toBe(1);
  // Queued once. A second pass must not stack a second edit on the same card.
  expect(queuePriceAmendments(db, Date.parse("2026-10-07T18:15:00.000Z"))).toBe(0);

  const calls: { url: string; method: string | undefined; body: Record<string, unknown> }[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "123456" });
  };
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("PATCH");
  const embed = (calls[0]?.body.embeds as Record<string, unknown>[] | undefined)?.[0];
  const fields = embed?.fields as { name: string; value: string }[] | undefined;
  // In the unit recorded against the source, and named, because a borrowed rate always is.
  expect(fields?.at(-1)).toMatchObject({
    name: "Price",
    value: "$0.1 in · $0.5 out / 1M tokens · Anthropic · API pricing",
  });
  // The edit is the card that was sent with one field added: no second message, nothing pinged.
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);
  expect(calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  db.close();
});

test("a launch card that already carried a price is left alone", () => {
  const db = openDatabase(":memory:");
  const gateway = (models: Collection["records"]): Collection => ({
    source: "openrouter",
    stream: "openrouter",
    url: "https://openrouter.ai",
    raw: [],
    records: models,
  });
  const earlier = { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" };
  saveCollection(db, gateway([earlier]), [wire], "2026-10-07T12:00:00.000Z");
  saveCollection(
    db,
    gateway([
      earlier,
      { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", pricing: { prompt: "0.0000001" } },
    ]),
    [wire],
    "2026-10-07T17:40:00.000Z",
  );
  prepareDeliveries(db, Date.parse("2026-10-07T17:52:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='123456'").run();
  // The blank is the point: a card whose body already names a rate has nothing to gain.
  expect(queuePriceAmendments(db, Date.parse("2026-10-07T18:14:00.000Z"))).toBe(0);
  db.close();
});

test("a reset announced and then applied is one card, edited, not two messages", async () => {
  const db = openDatabase(":memory:");
  const announcement = {
    id: "2109045392684032299",
    name: "Codex usage limits reset announced",
    maker: "OpenAI",
    stage: "Announced, not applied yet",
    announced: "2026-10-10 22:16 UTC",
    expected: "2026-10-11 07:00 UTC",
    resetType: "regular",
  };
  const confirmation = {
    id: "2109132167112782291",
    name: "Codex usage limits reset for everyone",
    maker: "OpenAI",
    stage: "Applied",
    announced: "2026-10-11 04:01 UTC",
    resetType: "regular",
  };
  const resets = (stage: "baseline" | "announced" | "applied"): Collection => ({
    source: "codex-resets",
    stream: "resets",
    url: "https://codex-resets.com",
    raw: [],
    records: [
      { id: "older", name: "Codex usage limits reset for everyone", stage: "Applied", resetType: "regular" },
      ...(stage === "baseline" ? [] : stage === "announced" ? [announcement] : [announcement, confirmation]),
    ],
  });
  // The first read of a source is its baseline and speaks for nothing.
  saveCollection(db, resets("baseline"), [wire], "2026-10-10T20:00:00.000Z");
  saveCollection(db, resets("announced"), [wire], "2026-10-10T22:28:00.000Z");
  prepareDeliveries(db, Date.parse("2026-10-10T22:29:00.000Z"));
  db.query("UPDATE deliveries SET status='sent',external_id='555'").run();
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);

  // The confirmation arrives five and a half hours later, as its own post and so its own record.
  saveCollection(db, resets("applied"), [wire], "2026-10-11T04:06:00.000Z");
  prepareDeliveries(db, Date.parse("2026-10-11T04:07:00.000Z"));
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);
  expect(
    db
      .query<{ reason: string }, []>("SELECT reason FROM suppressions")
      .all()
      .map((row) => row.reason),
  ).toContain("the_reset_it_confirms_was_announced");

  expect(queueResetAmendments(db, Date.parse("2026-10-11T04:08:00.000Z"))).toBe(1);
  expect(queueResetAmendments(db, Date.parse("2026-10-11T04:09:00.000Z"))).toBe(0);

  const calls: { body: Record<string, unknown> }[] = [];
  const request = async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "555" });
  };
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);
  await applyCardAmendments(db, { DISCORD_BOT_TOKEN: "t", destinations: [wire] } as never, request);

  expect(calls).toHaveLength(1);
  const embed = (calls[0]?.body.embeds as Record<string, unknown>[] | undefined)?.[0];
  expect(String(embed?.title)).toStartWith("🎉 ");
  expect(embed?.fields).toEqual([{ name: "Reset", value: "Applied 2026-10-11 04:01 UTC", inline: false }]);
  db.close();
});

test("a reset applied with nothing announced before it is still the only word a reader gets", () => {
  const db = openDatabase(":memory:");
  const applied: Collection = {
    source: "codex-resets",
    stream: "resets",
    url: "https://codex-resets.com",
    raw: [],
    records: [{ id: "older", name: "Codex usage limits reset for everyone", stage: "Applied", resetType: "regular" }],
  };
  saveCollection(db, applied, [wire], "2026-10-19T00:00:00.000Z");
  applied.records.push({
    id: "2112432076767289678",
    name: "Codex usage limits reset for everyone",
    maker: "OpenAI",
    stage: "Applied",
    announced: "2026-10-20 06:33 UTC",
    resetType: "regular",
  });
  saveCollection(db, applied, [wire], "2026-10-20T06:45:00.000Z");
  prepareDeliveries(db, Date.parse("2026-10-20T06:46:00.000Z"));

  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM deliveries").get()?.n).toBe(1);
  expect(queueResetAmendments(db, Date.parse("2026-10-20T06:47:00.000Z"))).toBe(0);
  db.close();
});
