import { afterEach, expect, test } from "bun:test";
import { type Destination, loadConfig } from "../src/config.js";
import { deliverPending, recoverInterruptedDeliveries } from "../src/delivery.js";
import { saveCollection } from "../src/events.js";
import { openDatabase } from "../src/storage/database.js";

const db = openDatabase(":memory:");
const config = loadConfig({
  CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname,
  TELEGRAM_BOT_TOKEN: "fake-telegram",
  DISCORD_BOT_TOKEN: "fake-discord",
});
const destinations: Destination[] = [
  { id: "tg", platform: "telegram", chatId: "-100123", topicId: 42, streams: ["news"] },
  { id: "dc", platform: "discord", channelId: "123456", streams: ["news"] },
];
afterEach(() =>
  db.exec(
    "DELETE FROM deliveries; DELETE FROM batches; DELETE FROM events; DELETE FROM records; DELETE FROM snapshots; DELETE FROM sources;",
  ),
);
function queue() {
  const c = { source: "test", stream: "news", url: "https://example.com", raw: [], records: [{ id: "a", name: "a" }] };
  saveCollection(db, c, destinations);
  c.records.push({ id: "b", name: "@everyone" });
  saveCollection(db, c, destinations);
}
test("sends to Telegram topic and Discord channel with bot auth and no mentions", async () => {
  queue();
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  await deliverPending(db, config, async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(url.includes("telegram") ? { ok: true, result: { message_id: 99 } } : { id: "999" });
  });
  expect(calls[0]?.body.chat_id).toBe("-100123");
  expect(calls[0]?.body.message_thread_id).toBe(42);
  expect(calls[1]?.url).toBe("https://discord.com/api/v10/channels/123456/messages");
  expect(calls[1]?.headers.get("Authorization")).toBe("Bot fake-discord");
  expect(calls[1]?.body.allowed_mentions).toEqual({ parse: [] });
  await deliverPending(db, config, async () => {
    throw new Error("must not send twice");
  });
  expect(db.query("SELECT status FROM deliveries").all()).toEqual([{ status: "sent" }, { status: "sent" }]);
});
test("rate limit retries only after requested delay", async () => {
  queue();
  let calls = 0;
  await deliverPending(db, config, async () => {
    calls++;
    return Response.json({ parameters: { retry_after: 60 } }, { status: 429 });
  });
  expect(calls).toBe(1);
  const row = db
    .query<{ status: string; next_attempt: number }, []>(
      "SELECT status,next_attempt FROM deliveries ORDER BY id LIMIT 1",
    )
    .get();
  expect(row?.status).toBe("pending");
  expect(row?.next_attempt).toBeGreaterThan(Date.now() + 50000);
});
test("network timeout and 5xx are ambiguous, not retried", async () => {
  queue();
  await deliverPending(db, config, async () => {
    throw new Error("https://api.telegram.org/botSECRET");
  });
  await deliverPending(db, config, async () => {
    throw new Error("must not retry");
  });
  const rows = db.query<{ status: string; error: string }, []>("SELECT status,error FROM deliveries").all();
  expect(rows.every((r) => r.status === "ambiguous" && !r.error.includes("SECRET"))).toBe(true);
});
test("restart recovers in-flight sends as ambiguous", () => {
  queue();
  db.exec("UPDATE deliveries SET status='sending'");
  recoverInterruptedDeliveries(db);
  expect(db.query("SELECT status FROM deliveries").all()).toEqual([{ status: "ambiguous" }, { status: "ambiguous" }]);
});
test("permanent platform rejection fails one target without blocking another", async () => {
  queue();
  await deliverPending(db, config, async (url) =>
    url.includes("telegram") ? new Response("forbidden", { status: 403 }) : Response.json({ id: "999" }),
  );
  expect(db.query("SELECT status FROM deliveries ORDER BY id").all()).toEqual([
    { status: "failed" },
    { status: "sent" },
  ]);
});

test("discord sends suppress the link unfurl", async () => {
  const db = openDatabase(":memory:");
  const destination: Destination = {
    id: "d",
    platform: "discord",
    channelId: "1",
    streams: ["openrouter"],
  };
  db.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'openrouter',0,1)").run();
  db.query(
    "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(1,'d',?,'text',0,0)",
  ).run(JSON.stringify(destination));

  let sent: Record<string, unknown> = {};
  await deliverPending(db, config, async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "9" }), { status: 200 });
  });
  // The unfurl is Discord's render of the linked site, not ours, and it dominates a phone screen.
  expect(sent.flags).toBe(4);
  db.close();
});
