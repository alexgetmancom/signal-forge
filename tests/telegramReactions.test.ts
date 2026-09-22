import { expect, test } from "bun:test";
import { openDatabase } from "../src/storage/database.js";
import { readTelegramReactions } from "../src/telegramReactions.js";

const config = { TELEGRAM_BOT_TOKEN: "777:secret" } as never;

function sentPost(db: ReturnType<typeof openDatabase>, messageId: string): number {
  db.query("INSERT INTO batches(source,digest,ready_at) VALUES('t',0,'2026-09-22T00:00:00.000Z')").run();
  return (
    db
      .query<{ id: number }, [string, string]>(
        `INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,status,external_id,updated_at)
         VALUES(1,'tg',?,'x',0,'sent',?,'2026-09-22T00:00:00.000Z') RETURNING id`,
      )
      .get(JSON.stringify({ id: "tg", platform: "telegram", chatId: "-100", signals: ["launch"] }), messageId)?.id ?? 0
  );
}

const reacted = (updateId: number, user: number, emoji: string[]) => ({
  update_id: updateId,
  message_reaction: {
    chat: { id: -100 },
    message_id: 55,
    user: { id: user },
    new_reaction: emoji.map((value) => ({ type: "emoji", emoji: value })),
  },
});

test("readers' 👍 and 👎 under a Telegram post are counted, a changed mind replaces the old one, and the bot's own is not", async () => {
  const db = openDatabase(":memory:");
  const delivery = sentPost(db, "55");
  const offsets: unknown[] = [];
  const answer = (result: unknown[]) => async (_url: string, init?: RequestInit) => {
    offsets.push(JSON.parse(String(init?.body)).offset);
    return Response.json({ ok: true, result });
  };
  await readTelegramReactions(
    db,
    config,
    answer([reacted(10, 777, ["👍"]), reacted(11, 1, ["👍"]), reacted(12, 2, ["👍"]), reacted(13, 3, ["👎"])]),
  );
  const totals = () => db.query("SELECT votes,against FROM scout_reactions WHERE delivery_id=?").get(delivery);
  expect(totals()).toEqual({ votes: 2, against: 1 });
  // Reader 2 changes their mind; the next read starts after what was already read.
  await readTelegramReactions(db, config, answer([reacted(14, 2, ["👎"])]));
  expect(totals()).toEqual({ votes: 1, against: 2 });
  expect(offsets).toEqual([0, 14]);
  db.close();
});

test("an anonymous count is taken as it is, less the bot's own 👍", async () => {
  const db = openDatabase(":memory:");
  const delivery = sentPost(db, "55");
  await readTelegramReactions(db, config, async () =>
    Response.json({
      ok: true,
      result: [
        {
          update_id: 1,
          message_reaction_count: {
            chat: { id: -100 },
            message_id: 55,
            reactions: [
              { type: { type: "emoji", emoji: "👍" }, total_count: 6 },
              { type: { type: "emoji", emoji: "👎" }, total_count: 1 },
            ],
          },
        },
      ],
    }),
  );
  expect(db.query("SELECT votes,against FROM scout_reactions WHERE delivery_id=?").get(delivery)).toEqual({
    votes: 5,
    against: 1,
  });
  db.close();
});
