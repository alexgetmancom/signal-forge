import { expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { prepareDeliveries } from "../src/events/batching.js";
import { promoteVouchedMessages } from "../src/promotion.js";
import { openDatabase } from "../src/storage/database.js";

const config = {
  DISCORD_BOT_TOKEN: "fake",
  destinations: [
    { id: "scouts", platform: "discord", channelId: "10", signals: ["codename", "evidence"] },
    { id: "wire", platform: "discord", channelId: "20", signals: ["launch", "change"] },
  ],
  promotion: { ownerUserId: "999", ownerEmoji: "✅", readerEmoji: "👍", readerVotes: 3 },
} as unknown as AppConfig;

function sighting(db: ReturnType<typeof openDatabase>) {
  db.query(
    "INSERT INTO batches(id,source,digest,ready_at,sealed) VALUES(1,'arena',0,'2026-09-08T00:00:00.000Z',1)",
  ).run();
  db.query(
    `INSERT INTO deliveries(id,batch_id,destination_id,destination_json,body,part,status,external_id,updated_at)
     VALUES(1,1,'scouts','{}','{"content":"","embeds":[{"title":"spicy-mayo"}]}',0,'sent','555','2026-09-08T00:00:00.000Z')`,
  ).run();
}

const answer = (reactions: { name: string; count: number }[], reactors: string[]) =>
  (async (url: string) =>
    String(url).includes("/reactions/")
      ? Response.json(reactors.map((id) => ({ id })))
      : Response.json([
          { id: "555", reactions: reactions.map((r) => ({ count: r.count, emoji: { name: r.name } })) },
        ])) as never;

test("enough readers carry a sighting into the public channel, once", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const at = Date.parse("2026-09-08T00:30:00.000Z");
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 3 }], []), at)).toBe(1);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 4 }], []), at)).toBe(0);

  prepareDeliveries(db, Date.parse("2026-09-08T01:00:00.000Z"));
  const body = db
    .query<{ body: string }, [string]>("SELECT body FROM deliveries WHERE destination_id=?")
    .get("wire")?.body;
  const payload = JSON.parse(String(body));
  expect(payload.embeds[0].title).toBe("spicy-mayo");
  expect(payload.content).toContain("3 scouts vouched");
  expect(payload.allowed_mentions).toEqual({ parse: [] });
});

test("two readers are not enough on their own", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "👍", count: 2 }], []))).toBe(0);
});

test("the owner alone settles it, and only the owner's own reaction counts", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  // Somebody else pressing the owner's emoji is not the owner.
  expect(await promoteVouchedMessages(db, config, answer([{ name: "✅", count: 1 }], ["123"]))).toBe(0);
  expect(await promoteVouchedMessages(db, config, answer([{ name: "✅", count: 1 }], ["999"]))).toBe(1);
  expect(db.query("SELECT reason FROM promoted_deliveries").get()).toEqual({ reason: "owner" });
});

test("a rejected read promotes nothing", async () => {
  const db = openDatabase(":memory:");
  sighting(db);
  const rejected = (async () => new Response("nope", { status: 403 })) as never;
  expect(await promoteVouchedMessages(db, config, rejected)).toBe(0);
});
