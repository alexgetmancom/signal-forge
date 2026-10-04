import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { readReactionsAndPublish } from "../src/promotion.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery } from "./fixtures/build.js";

const config = {
  DISCORD_BOT_TOKEN: "fake",
  destinations: [
    { id: "trail", platform: "discord", channelId: "10", signals: ["article"], feedback: "none" },
    { id: "news", platform: "discord", channelId: "20", signals: ["launch", "change"] },
    { id: "tg-news", platform: "telegram", chatId: "-100", signals: ["launch", "change"] },
  ],
  reactions: { likeEmoji: "👍", dislikeEmoji: "👎" },
  promotion: { ownerUserId: "777", publishEmoji: "❤️" },
} as unknown as AppConfig;

/** A card in the owner's own channel: nobody else reads it, and nothing goes out from it by itself. */
function card(db: ReturnType<typeof openDatabase>, destinationId = "trail", kind?: "weekly_recap") {
  aBatch(db, { id: 1, readyAt: "2026-09-08T00:00:00.000Z", ...(kind ? { kind, source: "daily-recap" } : {}) });
  aDelivery(db, {
    id: 1,
    batchId: 1,
    destinationId,
    destinationJson: "{}",
    body: '{"content":"","embeds":[{"title":"Anthropic on interpretability"}]}',
    externalId: "555",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
}

const answer = (reactions: { name: string; count: number; me?: boolean }[], reactors: string[], put: string[] = []) =>
  (async (url: string, init?: { method?: string }) => {
    if (init?.method === "PUT") {
      put.push(String(url));
      return new Response(null, { status: 204 });
    }
    return String(url).includes("/reactions/")
      ? Response.json(reactors.map((id) => ({ id })))
      : Response.json([
          {
            id: "555",
            reactions: reactions.map((r) => ({ count: r.count, me: r.me ?? false, emoji: { name: r.name } })),
          },
        ]);
  }) as never;

test("the owner's mark carries a card out of his own channel onto the whole wire, once", async () => {
  const db = openDatabase(":memory:");
  card(db);
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  expect(await readReactionsAndPublish(db, config, answer([{ name: "❤️", count: 1 }], ["777"]), at)).toBe(1);
  expect(await readReactionsAndPublish(db, config, answer([{ name: "❤️", count: 1 }], ["777"]), at)).toBe(0);

  prepareDeliveries(db, Date.parse("2026-09-08T01:00:00.000Z"));
  // Both transports of the wire, because a lane is one audience reached two ways.
  const rows = db
    .query<{ destination_id: string; body: string }, []>(
      "SELECT destination_id,body FROM deliveries WHERE id>1 ORDER BY destination_id",
    )
    .all();
  expect(rows.map((row) => row.destination_id)).toEqual(["news", "tg-news"]);
  const payload = JSON.parse(String(rows[0]?.body));
  expect(payload.embeds[0].title).toBe("Anthropic on interpretability");
  // Where it came from is the owner's bookkeeping; the reader is owed the observation.
  expect(payload.content).toBe("");
  expect(payload.allowed_mentions).toEqual({ parse: [] });
});

test("somebody else's heart carries nothing: a count cannot say whose hand it was", async () => {
  const db = openDatabase(":memory:");
  card(db);
  expect(await readReactionsAndPublish(db, config, answer([{ name: "❤️", count: 2 }], ["999"]))).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM promoted_deliveries").get()).toEqual({ c: 0 });
});

test("nobody is asked who reacted until there is a mark to ask about", async () => {
  const db = openDatabase(":memory:");
  card(db);
  const asked: string[] = [];
  const watch = (async (url: string) => {
    asked.push(String(url));
    return Response.json([{ id: "555", reactions: [{ count: 1, me: true, emoji: { name: "❤️" } }] }]);
  }) as never;
  // Our own seed is the only heart there: the owner has not pressed anything.
  expect(await readReactionsAndPublish(db, config, watch)).toBe(0);
  expect(asked.some((url) => url.includes("/reactions/"))).toBe(false);
});

test("readers no longer carry anything, and their thumbs are still counted", async () => {
  // Three 👍 in a public channel moved a card while the scout channel was hidden. Both channels
  // have been open since 2026-09-20; the votes are a measurement now and nothing else.
  const db = openDatabase(":memory:");
  card(db, "news");
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  const reactions = [
    { name: "👍", count: 5 },
    { name: "👎", count: 1 },
  ];
  expect(await readReactionsAndPublish(db, config, answer(reactions, []), at)).toBe(0);
  expect(db.query("SELECT votes,against FROM scout_reactions WHERE delivery_id=1").get()).toEqual({
    votes: 5,
    against: 1,
  });
});

test("the owner's own channel offers the mark and no thumbs, and keeps no vote", async () => {
  const db = openDatabase(":memory:");
  card(db);
  const put: string[] = [];
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  expect(await readReactionsAndPublish(db, config, answer([], [], put), at)).toBe(0);
  expect(put).toEqual(["https://discord.com/api/v10/channels/10/messages/555/reactions/%E2%9D%A4%EF%B8%8F/@me"]);
  // One hand is not an audience: a count of one here would read in a quality report as a room.
  expect(db.query("SELECT COUNT(*) c FROM scout_reactions").get()).toEqual({ c: 0 });
});

test("a channel with readers offers the pair to answer with, and not the mark", async () => {
  const db = openDatabase(":memory:");
  card(db, "news");
  const put: string[] = [];
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  await readReactionsAndPublish(db, config, answer([], [], put), at);
  expect(put).toEqual([
    "https://discord.com/api/v10/channels/20/messages/555/reactions/%F0%9F%91%8D/@me",
    "https://discord.com/api/v10/channels/20/messages/555/reactions/%F0%9F%91%8E/@me",
  ]);
});

test("the bot's own press is not a vote", async () => {
  const db = openDatabase(":memory:");
  card(db, "news");
  await readReactionsAndPublish(
    db,
    config,
    answer(
      [
        { name: "👍", count: 1, me: true },
        { name: "👎", count: 3, me: true },
      ],
      [],
    ),
    Date.parse("2026-09-08T00:30:00.000Z"),
  );
  expect(db.query("SELECT votes,against FROM scout_reactions WHERE delivery_id=1").get()).toEqual({
    votes: 0,
    against: 2,
  });
});

test("a rejected read promotes nothing", async () => {
  const db = openDatabase(":memory:");
  card(db);
  const rejected = (async () => new Response("nope", { status: 403 })) as never;
  expect(await readReactionsAndPublish(db, config, rejected)).toBe(0);
});

test("a recap the owner marked is not carried into the wire", async () => {
  // The morning recap drew a press on 2026-09-20 and was reposted whole to `news`, which had
  // received the same lines an hour and a half earlier. A recap is not a card about one thing.
  const db = openDatabase(":memory:");
  card(db, "trail", "weekly_recap");
  expect(await readReactionsAndPublish(db, config, answer([{ name: "❤️", count: 1 }], ["777"]))).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM promoted_deliveries").get()).toEqual({ c: 0 });
});
