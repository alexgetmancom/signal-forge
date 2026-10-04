import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type AppConfig, type Destination, judged } from "./config.js";
import { storageFailure } from "./failure.js";
import { featureEnabled } from "./features.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { writeTransaction } from "./storage/transaction.js";

/**
 * What readers press under a Discord card, and the owner's one press that publishes it.
 *
 * Two things that used to be one. The counting is a measurement: the bot puts 👍 and 👎 under every
 * card in a channel with readers, reads the counts back, and `scout_reactions` is what the reports
 * and a source's standing are built on. The publishing is an action, and the only one left: the
 * owner presses `publishEmoji` under a card in a channel of his own and it travels to the wire.
 *
 * They are apart because switching the action off used to take the measurement with it -- one
 * feature flag stood in front of both, and turning off a promotion nobody used would have emptied
 * the votes column and looked like readers who had stopped answering.
 *
 * The readers' own trigger is gone. Three 👍 in `radar` carried a sighting to `news` while `radar`
 * was hidden; both channels have been open since 2026-09-20 and it carried nothing in the two weeks
 * after. Its counts are still read -- votes say which sources a room vouches for, which is worth
 * knowing whether or not anything moves because of them.
 *
 * What travels is the message, not the event. The card was rendered when the observation was made,
 * with the evidence and the standing sentence that were true then; re-deriving it a day later
 * against records that have since moved would publish something nobody approved.
 *
 * What the bot has pressed, it can also take back. The offer follows the channel's settings and so
 * must the withdrawal, or narrowing a rule leaves the old invitation standing under every card that
 * was sent while it was wider -- which is what happened to the owner's own channels on 2026-10-04.
 *
 * Reactions are read, never listened for: one request lists the recent messages of a channel with
 * their counts, so this needs no socket held open and no port of our own. Who pressed is asked only
 * when the publish mark is there and is not ours, because a count cannot say whose hand it was and
 * only the owner's publishes.
 */
const messagesSchema = z.array(
  z.object({
    id: z.string(),
    reactions: z
      .array(
        z.object({
          count: z.number(),
          /** Whether our own reaction is among them: the seed is an invitation, not a vote. */
          me: z.boolean().default(false),
          emoji: z.object({ name: z.string().nullable() }),
        }),
      )
      .default([]),
  }),
);
const reactorsSchema = z.array(z.object({ id: z.string() }));
export const promotionContextSchema = z.object({
  deliveryId: z.number(),
  /** `readers` is kept because rows written before the owner became the only door carry it. */
  reason: z.enum(["owner", "readers"]),
  votes: z.number(),
});
type PromotionContext = z.infer<typeof promotionContextSchema>;

const API = "https://discord.com/api/v10";

type DiscordDestination = Extract<Destination, { platform: "discord" }>;

/** Where a published card goes: the channels subscribed to `launch`, found by what they carry. */
const wire = (config: AppConfig): Destination[] =>
  (config.destinations as Destination[]).filter((destination) => destination.signals.includes("launch"));

async function read<T>(url: string, config: AppConfig, request: Fetch, schema: z.ZodType<T>): Promise<T | null> {
  const response = await request(url, {
    headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
    // Without a bound, one stalled Discord connection holds shutdown open until the host kills it.
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    // The address carries a channel id and nothing secret, and the body may carry anything.
    log("warn", "Reaction read rejected", { status: response.status });
    return null;
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    log("warn", "Reaction read invalid");
    return null;
  }
  return parsed.data;
}

/**
 * Put one reaction under a card, so a reader has something to press, or take ours back off a card
 * that should never have carried it. Discord answers a reaction we already hold with 204 as well,
 * and so does a removal of one we do not, so a repeat of either costs nothing but the request.
 *
 * Taking one back is the half that was missing. What the bot offers follows the channel's settings,
 * but what it has already pressed follows nothing: between a deploy and the config edit that caught
 * up with it, 👍 and 👎 were seeded under 58 cards in the owner's own channels, and narrowing the
 * rule afterwards left every one of them standing. An invitation to vote that the channel no longer
 * extends is indistinguishable, to the reader looking at it, from one it does.
 */
async function press(
  channelId: string,
  messageId: string,
  emoji: string,
  method: "PUT" | "DELETE",
  config: AppConfig,
  request: Fetch,
) {
  const response = await request(
    `${API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    {
      method,
      headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`, "content-length": "0" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) log("warn", "Reaction change rejected", { status: response.status, method });
  await response.body?.cancel();
}

/**
 * How recent a card must be for its reactions to be worth changing, and how many presses and
 * withdrawals one pass will make between them. Both bound the first pass after a release, and the
 * first pass after a channel's settings change: fifty messages in five channels is two hundred and
 * fifty requests, and Discord would turn most of them away.
 *
 * Twelve hours was a guess that a card goes cold overnight, and it cost us the measurement: in the
 * first two days of asking, 105 cards carried the pair and 6 drew an answer. At that rate the fifty
 * answers the confidence question needs never arrive. The window is now the whole of what Discord
 * hands back -- fifty messages a channel -- because a reader scrolling back is exactly the reader
 * with an opinion, and a pass every five minutes has room to catch up.
 */
const SEED_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_CHANGES = 60;

type Card = {
  id: number;
  body: string;
  updated_at: string;
  kind: string;
};

/** Was the publish mark pressed by the owner? A count cannot say whose hand it was, so we ask. */
async function ownerMarked(
  channel: DiscordDestination,
  messageId: string,
  config: AppConfig,
  request: Fetch,
): Promise<boolean> {
  const rule = config.promotion;
  if (!rule) return false;
  const reactors = await read(
    `${API}/channels/${channel.channelId}/messages/${messageId}/reactions/${encodeURIComponent(rule.publishEmoji)}?limit=100`,
    config,
    request,
    reactorsSchema,
  );
  return (reactors ?? []).some((reactor) => reactor.id === rule.ownerUserId);
}

/**
 * Carry one card to the wire, exactly as it was written, and remember that it went.
 *
 * A card already in a wire channel is not carried: the readers it would be published to are the
 * readers who have it, and the owner pressing the mark there means he liked it.
 */
function publish(db: Database, config: AppConfig, card: Card, now: number): boolean {
  const targets = wire(config);
  if (!targets.length) return false;
  if (db.query("SELECT 1 FROM promoted_deliveries WHERE delivery_id=?").get(card.id)) return false;
  const context: PromotionContext = { deliveryId: card.id, reason: "owner", votes: 0 };
  promotionContextSchema.parse(context);
  writeTransaction(db, () => {
    const batch = db
      .query<{ id: number }, [string, string]>(
        "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES('scout-promotion',0,?,'promotion',?) RETURNING id",
      )
      .get(new Date(now).toISOString(), JSON.stringify(context));
    if (!batch) throw storageFailure("a promotion batch");
    for (const destination of targets)
      db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
        batch.id,
        destination.id,
        JSON.stringify(destination),
      );
    db.query("INSERT INTO promoted_deliveries(delivery_id,batch_id,reason,votes,promoted_at) VALUES(?,?,?,?,?)").run(
      card.id,
      batch.id,
      context.reason,
      context.votes,
      new Date(now).toISOString(),
    );
  });
  return true;
}

/**
 * Read every Discord channel's recent cards: count the thumbs where there are readers to raise
 * them, and carry what the owner has marked.
 *
 * Returns how many travelled, which is what the worker logs and the tests assert.
 */
export async function readReactionsAndPublish(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<number> {
  if (!config.DISCORD_BOT_TOKEN) return 0;
  const counting = featureEnabled(config, "reader-votes");
  const publishing = featureEnabled(config, "promotion") && Boolean(config.promotion);
  if (!counting && !publishing) return 0;
  const channels = (config.destinations as Destination[]).filter(
    (destination): destination is DiscordDestination => destination.platform === "discord",
  );
  const onTheWire = new Set(wire(config).map((destination) => destination.id));
  let promoted = 0;
  let changes = 0;
  for (const channel of channels) {
    const counted = counting && judged(channel);
    const messages = await read(
      `${API}/channels/${channel.channelId}/messages?limit=50`,
      config,
      request,
      messagesSchema,
    );
    if (!messages) continue;
    for (const message of messages) {
      const card = db
        .query<Card, [string, string]>(
          `SELECT d.id,d.body,d.updated_at,b.kind FROM deliveries d JOIN batches b ON b.id=d.batch_id
            WHERE d.external_id=? AND d.destination_id=? AND d.status='sent'`,
        )
        .get(message.id, channel.id);
      if (!card) continue;
      const reaction = (name: string) => message.reactions.find((entry) => entry.emoji.name === name);
      const votesFor = (name: string) => {
        const entry = reaction(name);
        return entry ? entry.count - (entry.me ? 1 : 0) : 0;
      };
      const rule = config.reactions;
      // Only where there are readers: one hand in the owner's own channel is not an audience, and a
      // count of one in a quality report reads as if a room had answered.
      if (counted)
        db.query(
          `INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)
           ON CONFLICT(delivery_id) DO UPDATE SET votes=excluded.votes,against=excluded.against,read_at=excluded.read_at`,
        ).run(card.id, votesFor(rule.likeEmoji), votesFor(rule.dislikeEmoji), new Date(now).toISOString());

      // What the bot offers is what the channel is for: a pair to answer with where there are
      // readers, the publish mark where the only hand is the owner's. The mark is offered by what a
      // channel is rather than by where a card would land -- `radar` is not the wire, but it is a
      // room full of strangers, and a door out of it is a second way into a channel that already
      // has one. Both conditions stay: a channel of the owner's that is also on the wire would
      // otherwise be offered a door into itself.
      const offered = [...(counted ? [rule.likeEmoji, rule.dislikeEmoji] : [])];
      const marking = publishing && Boolean(config.promotion) && !judged(channel) && !onTheWire.has(channel.id);
      if (marking && config.promotion) offered.push(config.promotion.publishEmoji);
      if (changes < MAX_CHANGES && now - Date.parse(card.updated_at) < SEED_WINDOW_MS) {
        for (const emoji of offered)
          if (!reaction(emoji)?.me) {
            await press(channel.channelId, message.id, emoji, "PUT", config, request);
            changes += 1;
          }
        // And back off the ones this channel no longer asks for. Only our own press is ever taken
        // back: a reader's answer is theirs, and a count that outlived the question is still an
        // answer somebody gave.
        for (const held of message.reactions)
          if (held.me && held.emoji.name && !offered.includes(held.emoji.name)) {
            await press(channel.channelId, message.id, held.emoji.name, "DELETE", config, request);
            changes += 1;
          }
      }

      if (!marking || !config.promotion) continue;
      // A card travels; a recap does not. The morning recap in `radar` drew a vote on 2026-09-20 and
      // the whole of it was reposted to `news`, where the same lines had already been sent an hour
      // and a half earlier. Only the message about one thing is a message worth moving.
      if (card.kind !== "event") continue;
      if (votesFor(config.promotion.publishEmoji) < 1) continue;
      if (db.query("SELECT 1 FROM promoted_deliveries WHERE delivery_id=?").get(card.id)) continue;
      if (!(await ownerMarked(channel, message.id, config, request))) continue;
      if (publish(db, config, card, now)) promoted += 1;
    }
  }
  return promoted;
}
