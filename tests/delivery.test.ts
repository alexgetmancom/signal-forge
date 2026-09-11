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
  {
    id: "tg",
    platform: "telegram",
    chatId: "-100123",
    topicId: 42,
    signals: ["launch", "codename", "evidence", "change"],
  },
  { id: "dc", platform: "discord", channelId: "123456", signals: ["launch", "codename", "evidence", "change"] },
];
afterEach(() =>
  db.exec(
    "DELETE FROM deliveries; DELETE FROM lifecycle_reminders; DELETE FROM hypothesis_events; DELETE FROM model_fact_conflicts; DELETE FROM model_fact_fields; DELETE FROM model_facts; DELETE FROM hypotheses; DELETE FROM lifecycle_deadlines; DELETE FROM batch_targets; DELETE FROM batch_events; DELETE FROM batches; DELETE FROM events; DELETE FROM records; DELETE FROM snapshots; DELETE FROM sources;",
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
test("rate limits each destination lane and retries only after requested delay", async () => {
  queue();
  let calls = 0;
  await deliverPending(db, config, async () => {
    calls++;
    return Response.json({ parameters: { retry_after: 60 } }, { status: 429 });
  });
  expect(calls).toBe(2);
  const row = db
    .query<{ status: string; next_attempt: number }, []>(
      "SELECT status,next_attempt FROM deliveries ORDER BY id LIMIT 1",
    )
    .get();
  expect(row?.status).toBe("pending");
  expect(row?.next_attempt).toBeGreaterThan(Date.now() + 50000);
});
test("rate limit does not block an independent destination", async () => {
  const local = openDatabase(":memory:");
  const telegram = {
    id: "tg",
    platform: "telegram" as const,
    chatId: "1",
    signals: ["launch", "codename", "evidence", "change"],
  };
  const discord = {
    id: "dc",
    platform: "discord" as const,
    channelId: "2",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1),(2,'test',0,1)").run();
  local
    .query(
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,updated_at) VALUES(1,1,'tg',?,'tg',0,0),(2,2,'dc',?,'dc',0,0)",
    )
    .run(JSON.stringify(telegram), JSON.stringify(discord));
  await deliverPending(local, config, async (url) =>
    url.includes("telegram")
      ? Response.json({ parameters: { retry_after: 60 } }, { status: 429 })
      : Response.json({ id: "999" }),
  );
  expect(local.query("SELECT status,next_attempt FROM deliveries WHERE id=1").get()).toMatchObject({
    status: "pending",
  });
  expect(local.query("SELECT status,next_attempt FROM deliveries WHERE id=2").get()).toEqual({
    status: "sent",
    next_attempt: 0,
  });
  local.close();
});
test("a rate limit does not block another destination on the same platform", async () => {
  const local = openDatabase(":memory:");
  const first = {
    id: "tg-1",
    platform: "telegram" as const,
    chatId: "1",
    signals: ["launch", "codename", "evidence", "change"],
  };
  const second = {
    id: "tg-2",
    platform: "telegram" as const,
    chatId: "2",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1),(2,'test',0,1)").run();
  local
    .query(
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,updated_at) VALUES(1,1,'tg-1',?,'one',0,0),(2,2,'tg-2',?,'two',0,0)",
    )
    .run(JSON.stringify(first), JSON.stringify(second));
  await deliverPending(local, config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: string };
    return body.chat_id === "1"
      ? Response.json({ parameters: { retry_after: 60 } }, { status: 429 })
      : Response.json({ ok: true, result: { message_id: 2 } });
  });
  expect(local.query("SELECT status FROM deliveries WHERE id=1").get()).toEqual({ status: "pending" });
  expect(local.query("SELECT status FROM deliveries WHERE id=2").get()).toEqual({ status: "sent" });
  local.close();
});
test("preflight delivery failures are failed without making a provider request", async () => {
  const local = openDatabase(":memory:");
  const telegram = {
    id: "tg",
    platform: "telegram" as const,
    chatId: "1",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  local
    .query(
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,updated_at) VALUES(1,1,'tg',?,'body',0,0),(2,1,'bad','{','body',1,0)",
    )
    .run(JSON.stringify(telegram));
  let calls = 0;
  await deliverPending(local, { ...config, TELEGRAM_BOT_TOKEN: undefined }, async () => {
    calls += 1;
    throw new Error("must not send");
  });
  expect(calls).toBe(0);
  expect(local.query("SELECT id,status,error FROM deliveries ORDER BY id").all()).toEqual([
    {
      id: 1,
      status: "failed",
      error: "Delivery rejected before external request: invalid destination or missing credentials",
    },
    {
      id: 2,
      status: "failed",
      error: "Delivery rejected before external request: invalid destination or missing credentials",
    },
  ]);
  local.close();
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
test("a later multipart part waits behind an ambiguous earlier part", async () => {
  const local = openDatabase(":memory:");
  const destination = {
    id: "dc",
    platform: "discord" as const,
    channelId: "123456",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  const insert = local.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  insert.run(1, 1, destination.id, JSON.stringify(destination), "part 0", 0, "ambiguous", 0);
  insert.run(2, 1, destination.id, JSON.stringify(destination), "part 1", 1, "pending", 0);
  let calls = 0;
  await deliverPending(local, config, async () => {
    calls++;
    return Response.json({ id: "999" });
  });
  expect(calls).toBe(0);
  expect(local.query("SELECT id,status FROM deliveries ORDER BY id").all()).toEqual([
    { id: 1, status: "ambiguous" },
    { id: 2, status: "pending" },
  ]);
  local.close();
});
test("an unresolved delivery blocks only later parts in its own batch", async () => {
  const local = openDatabase(":memory:");
  const destination = {
    id: "dc",
    platform: "discord" as const,
    channelId: "123456",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1),(2,'test',0,1)").run();
  const insert = local.query(
    "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  insert.run(1, 1, destination.id, JSON.stringify(destination), "old", 0, "failed", 0);
  insert.run(2, 2, destination.id, JSON.stringify(destination), "new", 0, "pending", 0);
  let calls = 0;
  await deliverPending(local, config, async () => {
    calls++;
    return Response.json({ id: "999" });
  });
  expect(calls).toBe(1);
  expect(local.query("SELECT id,status FROM deliveries ORDER BY id").all()).toEqual([
    { id: 1, status: "failed" },
    { id: 2, status: "sent" },
  ]);
  local.close();
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
test("a Telegram application error is a failed delivery, not an ambiguous send", async () => {
  const local = openDatabase(":memory:");
  const telegram = {
    id: "tg",
    platform: "telegram" as const,
    chatId: "1",
    signals: ["launch", "codename", "evidence", "change"],
  };
  local.query("INSERT INTO batches(id,source,ready_at,sealed) VALUES(1,'test',0,1)").run();
  local
    .query(
      "INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,updated_at) VALUES(1,1,'tg',?,'body',0,0)",
    )
    .run(JSON.stringify(telegram));
  await deliverPending(local, config, async () =>
    Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 200 }),
  );
  expect(local.query("SELECT status,error FROM deliveries").get()).toEqual({
    status: "failed",
    error: "Telegram rejected delivery",
  });
  local.close();
});

test("discord sends suppress the link unfurl", async () => {
  const db = openDatabase(":memory:");
  const destination: Destination = {
    id: "d",
    platform: "discord",
    channelId: "1",
    signals: ["launch", "codename", "evidence", "change"],
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

test("a message built from embeds is not sent with the embed-suppressing flag", async () => {
  const sent: Record<string, unknown>[] = [];
  const request = async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  };
  const local = openDatabase(":memory:");
  local.query("INSERT INTO batches(id,source,digest,ready_at) VALUES(0,'test',0,0)").run();
  const destination = {
    id: "d",
    platform: "discord" as const,
    channelId: "42",
    signals: ["launch", "codename", "evidence", "change"],
  };
  const queue = (body: string) =>
    local
      .query(
        "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(0,?,?,?,0,0)",
      )
      .run(destination.id, JSON.stringify(destination), body);
  queue(JSON.stringify({ content: "Header", embeds: [{ title: "One" }] }));
  await deliverPending(local, config, request);
  expect(sent[0]?.flags).toBeUndefined();
  local.query("DELETE FROM deliveries").run();
  // Plain text still suppresses the unfurl, which is what the flag was added for.
  queue("Plain https://example.test");
  await deliverPending(local, config, request);
  expect(sent[1]?.flags).toBe(4);
});
