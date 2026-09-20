import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";

/**
 * The readers of `radar` deciding what a stranger should see.
 *
 * Everything in `radar` is early, and whether an unnamed arena entry deserves a public reader's
 * attention is a judgement no rule here can make. The readers of that channel can, and a reaction is
 * how they say so: enough of them and the message travels to `news`.
 *
 * The owner's own like used to settle it alone. That power was worth having when `radar` was hidden
 * and `news` was the only thing a stranger could see, so a promotion was the one way to publish. Both
 * channels are now visible, nothing is waiting behind a door, and a card the owner alone liked was
 * being copied from one open channel to another for no one's benefit. Only the readers move anything.
 *
 * What travels is the message, not the event. The card was rendered when the observation was made,
 * with the evidence and the standing sentence that were true then; re-deriving it a day later
 * against records that have since moved would publish something nobody approved.
 *
 * Reactions are read, never listened for: one request lists the recent messages of a channel with
 * their counts, and the counts are the whole answer -- so this needs no socket held open and no port
 * of our own.
 *
 * The bot puts both reactions under each card it sends, and both channels are read, not only
 * `radar`. A reader answers by pressing what is already there, and the three answers stay apart: a like
 * is worth sending, a dislike is not, and an untouched card is one nobody read. Counted as approval,
 * silence and refusal were the same number, which is why the column could never be compared with
 * Jev's judgement of the same event.
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
export const promotionContextSchema = z.object({
  deliveryId: z.number(),
  /** Kept as a field, not dropped, because rows written before the owner's own vote was retired carry it. */
  reason: z.literal("readers"),
  votes: z.number(),
});
type PromotionContext = z.infer<typeof promotionContextSchema>;

const API = "https://discord.com/api/v10";

type DiscordDestination = Extract<Destination, { platform: "discord" }>;

/**
 * The two channels, found by what they carry rather than by name: `radar` is the one subscribed to
 * `codename`, `news` the ones subscribed to `launch`. Renaming a channel in Discord therefore
 * changes nothing here, which is how `signals` and `scouts` became `news` and `radar` on 2026-09-20.
 */
function radarAndNews(config: AppConfig): { radar: DiscordDestination; news: Destination[] } | null {
  const destinations = config.destinations as Destination[];
  const radar = destinations.find(
    (destination): destination is DiscordDestination =>
      destination.platform === "discord" && destination.signals.includes("codename"),
  );
  const news = destinations.filter(
    (destination) => destination.platform === "discord" && destination.signals.includes("launch"),
  );
  return radar && news.length && !news.includes(radar) ? { radar, news } : null;
}

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
 * Put one reaction under a card, so a reader has something to press. Discord answers a reaction we
 * already hold with 204 as well, so a repeat costs nothing but the request.
 */
async function offer(channelId: string, messageId: string, emoji: string, config: AppConfig, request: Fetch) {
  const response = await request(
    `${API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`, "content-length": "0" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) log("warn", "Reaction offer rejected", { status: response.status });
  await response.body?.cancel();
}

/**
 * How recent a card must be to be worth offering reactions under, and how many offers one pass will
 * make. Both bound the first pass after a release: fifty messages in two channels is two hundred
 * requests, and Discord would turn most of them away. Nobody votes on a week-old card, so the
 * backlog is left alone rather than caught up with.
 */
const SEED_WINDOW_MS = 12 * 3_600_000;
const MAX_SEEDS = 20;

/**
 * Promote every message in `radar` that its readers have vouched for since the last pass.
 *
 * Returns how many travelled, which is what the worker logs and the tests assert.
 */
export async function promoteVouchedMessages(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<number> {
  const rule = config.promotion;
  const channels = radarAndNews(config);
  if (!rule || !channels || !config.DISCORD_BOT_TOKEN) return 0;
  let promoted = 0;
  let seeds = 0;
  // Both channels, because a vote in `news` is the same measurement as a vote in `radar`; only
  // `radar`'s votes move anything, since `news` is already where a promotion would send it.
  for (const channel of [channels.radar, ...channels.news] as DiscordDestination[]) {
    const messages = await read(
      `${API}/channels/${channel.channelId}/messages?limit=50`,
      config,
      request,
      messagesSchema,
    );
    if (!messages) continue;
    for (const message of messages) {
      const delivery = db
        .query<{ id: number; body: string; updated_at: string; kind: string }, [string, string]>(
          `SELECT d.id,d.body,d.updated_at,b.kind FROM deliveries d JOIN batches b ON b.id=d.batch_id
            WHERE d.external_id=? AND d.destination_id=? AND d.status='sent'`,
        )
        .get(message.id, channel.id);
      if (!delivery) continue;
      const reaction = (name: string) => message.reactions.find((entry) => entry.emoji.name === name);
      const votesFor = (name: string) => {
        const entry = reaction(name);
        return entry ? entry.count - (entry.me ? 1 : 0) : 0;
      };
      const readerVotes = votesFor(rule.likeEmoji);
      // Every card's count is kept, not only the ones that travel: which source the readers vouch for
      // is the measurement, and promotion is one use of it.
      db.query(
        `INSERT INTO scout_reactions(delivery_id,votes,against,read_at) VALUES(?,?,?,?)
         ON CONFLICT(delivery_id) DO UPDATE SET votes=excluded.votes,against=excluded.against,read_at=excluded.read_at`,
      ).run(delivery.id, readerVotes, votesFor(rule.dislikeEmoji), new Date(now).toISOString());

      if (seeds < MAX_SEEDS && now - Date.parse(delivery.updated_at) < SEED_WINDOW_MS)
        for (const emoji of [rule.likeEmoji, rule.dislikeEmoji])
          if (!reaction(emoji)?.me) {
            await offer(channel.channelId, message.id, emoji, config, request);
            seeds += 1;
          }

      if (channel.id !== channels.radar.id) continue;
      // A card travels; a recap does not. The morning recap in `radar` drew a vote on 2026-09-20 and
      // the whole of it was reposted to `news`, where the same lines had already been sent an hour
      // and a half earlier. Only the message about one thing is a message worth moving.
      if (delivery.kind !== "event") continue;
      if (db.query("SELECT 1 FROM promoted_deliveries WHERE delivery_id=?").get(delivery.id)) continue;

      // A channel that is arguing has not vouched for anything: the dislikes have to be the minority.
      if (readerVotes < rule.readerVotes || votesFor(rule.dislikeEmoji) >= readerVotes) continue;

      const context: PromotionContext = { deliveryId: delivery.id, reason: "readers", votes: readerVotes };
      promotionContextSchema.parse(context);
      db.transaction(() => {
        const batch = db
          .query<{ id: number }, [string, string]>(
            "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES('scout-promotion',0,?,'promotion',?) RETURNING id",
          )
          .get(new Date(now).toISOString(), JSON.stringify(context));
        if (!batch) throw new Error("Promotion batch insert failed");
        for (const destination of channels.news)
          db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
            batch.id,
            destination.id,
            JSON.stringify(destination),
          );
        db.query(
          "INSERT INTO promoted_deliveries(delivery_id,batch_id,reason,votes,promoted_at) VALUES(?,?,?,?,?)",
        ).run(delivery.id, batch.id, context.reason, context.votes, new Date(now).toISOString());
      })();
      promoted += 1;
    }
  }
  return promoted;
}
