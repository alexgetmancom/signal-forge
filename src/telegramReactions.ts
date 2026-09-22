import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";

/**
 * The readers' 👍 and 👎 under the Telegram posts, counted like Discord's.
 *
 * Every post goes out with the bot's own 👍 so there is something to tap; that one is the bot's and
 * never counted. A reader's other emoji are kept in the rows but only the two that answer "was this
 * worth sending" reach the totals.
 */
const FOR = "👍";
const AGAINST = "👎";

const reactionType = z.object({ type: z.string(), emoji: z.string().optional() });
const update = z.object({
  update_id: z.number().int(),
  message_reaction: z
    .object({
      chat: z.object({ id: z.number() }),
      message_id: z.number().int(),
      user: z.object({ id: z.number() }).optional(),
      actor_chat: z.object({ id: z.number() }).optional(),
      new_reaction: z.array(reactionType),
    })
    .optional(),
  message_reaction_count: z
    .object({
      chat: z.object({ id: z.number() }),
      message_id: z.number().int(),
      reactions: z.array(z.object({ type: reactionType, total_count: z.number().int() })),
    })
    .optional(),
});
const updates = z.object({ ok: z.literal(true), result: z.array(z.unknown()) });

const emojiOf = (reaction: z.infer<typeof reactionType>) => (reaction.type === "emoji" ? reaction.emoji : undefined);

/** Reads what changed since the last pass, applies it, and returns how many changes it read. */
export async function readTelegramReactions(db: Database, config: AppConfig, request: Fetch = fetch): Promise<number> {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) return 0;
  const bot = Number(token.split(":")[0]);
  const offset = db.query<{ next_update: number }, []>("SELECT next_update FROM telegram_cursor WHERE id=1").get();
  const response = await request(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset: offset?.next_update ?? 0,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message_reaction", "message_reaction_count"],
    }),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    log("warn", "Telegram reactions not read", { status: response.status });
    return 0;
  }
  const read = updates.parse(await response.json()).result.flatMap((raw) => {
    const parsed = update.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  if (!read.length) return 0;
  const touched = new Set<string>();
  db.transaction(() => {
    for (const change of read) {
      const person = change.message_reaction;
      if (person) {
        const actor = person.user?.id ?? person.actor_chat?.id ?? 0;
        if (actor === bot) continue;
        const chat = String(person.chat.id);
        db.query("DELETE FROM telegram_reactions WHERE chat_id=? AND message_id=? AND actor=?").run(
          chat,
          person.message_id,
          actor,
        );
        for (const emoji of person.new_reaction.map(emojiOf))
          if (emoji)
            db.query(
              "INSERT OR IGNORE INTO telegram_reactions(chat_id,message_id,actor,emoji,count) VALUES(?,?,?,?,1)",
            ).run(chat, person.message_id, actor, emoji);
        touched.add(`${chat}:${person.message_id}`);
      }
      const anonymous = change.message_reaction_count;
      if (anonymous) {
        const chat = String(anonymous.chat.id);
        db.query("DELETE FROM telegram_reactions WHERE chat_id=? AND message_id=? AND actor=0").run(
          chat,
          anonymous.message_id,
        );
        for (const reaction of anonymous.reactions) {
          const emoji = emojiOf(reaction.type);
          // The anonymous count includes the bot's own 👍.
          const count = emoji === FOR ? reaction.total_count - 1 : reaction.total_count;
          if (emoji && count > 0)
            db.query("INSERT INTO telegram_reactions(chat_id,message_id,actor,emoji,count) VALUES(?,?,0,?,?)").run(
              chat,
              anonymous.message_id,
              emoji,
              count,
            );
        }
        touched.add(`${chat}:${anonymous.message_id}`);
      }
    }
    const next = Math.max(...read.map((change) => change.update_id)) + 1;
    db.query(
      "INSERT INTO telegram_cursor(id,next_update) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_update=excluded.next_update",
    ).run(next);
    const now = new Date().toISOString();
    for (const key of touched) {
      const [chat = "", message = ""] = key.split(":");
      const totals = db
        .query<{ votes: number; against: number }, [string, string, string, number]>(
          `SELECT COALESCE(SUM(CASE WHEN emoji=? THEN count END),0) votes,
             COALESCE(SUM(CASE WHEN emoji=? THEN count END),0) against
           FROM telegram_reactions WHERE chat_id=? AND message_id=?`,
        )
        .get(FOR, AGAINST, chat, Number(message)) ?? { votes: 0, against: 0 };
      const deliveries = db
        .query<{ id: number }, [string, string]>(
          `SELECT id FROM deliveries WHERE status='sent' AND external_id=?
             AND json_extract(destination_json,'$.platform')='telegram'
             AND CAST(json_extract(destination_json,'$.chatId') AS TEXT)=?`,
        )
        .all(message, chat);
      for (const delivery of deliveries)
        db.query(
          `INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)
           ON CONFLICT(delivery_id) DO UPDATE SET votes=excluded.votes,against=excluded.against,read_at=excluded.read_at`,
        ).run(delivery.id, totals.votes, totals.against, now);
    }
  })();
  return read.length;
}
