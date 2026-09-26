import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { promoteVouchedMessages } from "../src/promotion.js";
import { openDatabase } from "../src/storage/database.js";
import { aBatch, aDelivery } from "./fixtures/build.js";

const config = {
  DISCORD_BOT_TOKEN: "fake",
  destinations: [
    { id: "radar", platform: "discord", channelId: "10", signals: ["codename", "evidence"] },
    { id: "news", platform: "discord", channelId: "20", signals: ["launch", "change"] },
  ],
  promotion: { likeEmoji: "👍", dislikeEmoji: "👎", readerVotes: 3 },
} as unknown as AppConfig;

function sighting(db: ReturnType<typeof openDatabase>) {
  aBatch(db, { id: 1, readyAt: "2026-09-08T00:00:00.000Z" });
  aDelivery(db, {
    id: 1,
    batchId: 1,
    destinationId: "radar",
    destinationJson: "{}",
    body: '{"content":"","embeds":[{"title":"spicy-mayo"}]}',
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

test("enough readers carry a sighting into the public channel, once", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 3 }], []), at)).toBe(1);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 4 }], []), at)).toBe(0);

  prepareDeliveries(db, Date.parse("2026-09-08T01:00:00.000Z"));
  const body = db
    .query<{ body: string }, [string]>("SELECT body FROM deliveries WHERE destination_id=?")
    .get("news")?.body;
  const payload = JSON.parse(String(body));
  expect(payload.embeds[0].title).toBe("spicy-mayo");
  expect(payload.content).toContain("3 readers vouched");
  expect(payload.allowed_mentions).toEqual({ parse: [] });
});

test("two readers are not enough on their own", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 2 }], []))).toBe(0);
});

test("the owner's own like no longer carries anything by itself", async () => {
  // It did while `radar` was hidden and promotion was the only way to publish. Both channels are
  // open now, so an owner-only like was copying a card from one visible channel to another.
  const db = openDatabase(":memory:");
  sighting(db);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "\u{1F44D}", count: 1 }], ["999"]))).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM promoted_deliveries").get()).toEqual({ c: 0 });
  // Nobody is asked who reacted any more: the counts are the whole answer.
  const asked: string[] = [];
  const watch = (async (url: string) => {
    asked.push(String(url));
    return Response.json([{ id: "555", reactions: [{ count: 1, me: false, emoji: { name: "\u{1F44D}" } }] }]);
  }) as never;
  await promoteVouchedMessages(db, config, watch);
  expect(asked.some((url) => url.includes("/reactions/"))).toBe(false);
});

test("the bot puts both reactions under a fresh card, and its own press is not a vote", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const put: string[] = [];
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  expect(await promoteVouchedMessages(db, config, answer([], [], put), at)).toBe(0);
  expect(put).toEqual([
    "https://discord.com/api/v10/channels/10/messages/555/reactions/%F0%9F%91%8D/@me",
    "https://discord.com/api/v10/channels/10/messages/555/reactions/%F0%9F%91%8E/@me",
  ]);

  // Both now carry our own seed, and a card nobody has answered must read as nobody, not as one.
  await promoteVouchedMessages(
    db,
    config,
    answer(
      [
        { name: "👍", count: 1, me: true },
        { name: "👎", count: 3, me: true },
      ],
      [],
    ),
    at,
  );
  expect(db.query("SELECT votes,against FROM scout_reactions WHERE delivery_id=1").get()).toEqual({
    votes: 0,
    against: 2,
  });
});

test("a channel that dislikes a card more than it likes it carries nothing", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const reactions = [
    { name: "👍", count: 4, me: true },
    { name: "👎", count: 4, me: true },
  ];
  expect(await promoteVouchedMessages(db, config, answer(reactions, []))).toBe(0);
});

test("a rejected read promotes nothing", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const rejected = (async () => new Response("nope", { status: 403 })) as never;
  expect(await promoteVouchedMessages(db, config, rejected)).toBe(0);
});

test("a recap the readers liked is not carried into the other channel", async () => {
  // The morning recap in `radar` drew votes on 2026-09-20 and was reposted whole to `news`, which
  // had received the same lines an hour and a half earlier. A recap is not a card about one thing.
  const db = openDatabase(":memory:");
  aBatch(db, { id: 1, source: "daily-recap", readyAt: "2026-09-08T00:00:00.000Z", kind: "weekly_recap" });
  aDelivery(db, {
    id: 1,
    batchId: 1,
    destinationId: "radar",
    destinationJson: "{}",
    body: '{"content":"","embeds":[{"title":"WHAT MOVED"}]}',
    externalId: "555",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 5 }], []))).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM promoted_deliveries").get()).toEqual({ c: 0 });
  // The vote is still recorded: it says the readers wanted that, wherever it can travel.
  expect(db.query("SELECT votes FROM scout_reactions WHERE delivery_id=1").get()).toEqual({ votes: 5 });
});
