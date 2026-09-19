import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";

/**
 * The scouts deciding what a stranger should see.
 *
 * Everything in the invited room is early, and whether an unnamed arena entry deserves a public
 * reader's attention is a judgement no rule here can make. The people invited to that room can, and
 * a reaction is how they say so: enough of them, or one from the owner, and the message travels.
 *
 * What travels is the message, not the event. The card was rendered when the observation was made,
 * with the evidence and the standing sentence that were true then; re-deriving it a day later
 * against records that have since moved would publish something nobody approved.
 *
 * Reactions are read, never listened for. One request lists the recent messages of the room with
 * their counts, and only a message that has already reached the bar costs a second request to ask
 * who reacted -- so the owner's veto power needs no socket held open and no port of our own.
 *
 * The bot puts both reactions under each card it sends, and both channels are read, not only the
 * room. A reader answers by pressing what is already there, and the three answers stay apart: a like
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
const reactorsSchema = z.array(z.object({ id: z.string() }));

export const promotionContextSchema = z.object({
  deliveryId: z.number(),
  reason: z.enum(["owner", "readers"]),
  votes: z.number(),
});
type PromotionContext = z.infer<typeof promotionContextSchema>;

const API = "https://discord.com/api/v10";

type DiscordDestination = Extract<Destination, { platform: "discord" }>;

function roomAndWire(config: AppConfig): { room: DiscordDestination; wire: Destination[] } | null {
  const destinations = config.destinations as Destination[];
  const room = destinations.find(
    (destination): destination is DiscordDestination =>
      destination.platform === "discord" && destination.signals.includes("codename"),
  );
  const wire = destinations.filter(
    (destination) => destination.platform === "discord" && destination.signals.includes("launch"),
  );
  return room && wire.length && !wire.includes(room) ? { room, wire } : null;
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
 * Promote every message in the room that the scouts have vouched for since the last pass.
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
  const channels = roomAndWire(config);
  if (!rule || !channels || !config.DISCORD_BOT_TOKEN) return 0;
  let promoted = 0;
  let seeds = 0;
  // Both channels, because a vote on the wire is the same measurement as a vote in the room; only
  // the room's votes move anything, since the wire is already where a promotion would send it.
  for (const channel of [channels.room, ...channels.wire] as DiscordDestination[]) {
    const messages = await read(
      `${API}/channels/${channel.channelId}/messages?limit=50`,
      config,
      request,
      messagesSchema,
    );
    if (!messages) continue;
    for (const message of messages) {
      const delivery = db
        .query<{ id: number; body: string; updated_at: string }, [string, string]>(
          "SELECT id,body,updated_at FROM deliveries WHERE external_id=? AND destination_id=? AND status='sent'",
        )
        .get(message.id, channel.id);
      if (!delivery) continue;
      const reaction = (name: string) => message.reactions.find((entry) => entry.emoji.name === name);
      const votesFor = (name: string) => {
        const entry = reaction(name);
        return entry ? entry.count - (entry.me ? 1 : 0) : 0;
      };
      const readerVotes = votesFor(rule.likeEmoji);
      // Every card's count is kept, not only the ones that travel: which source the room vouches for is
      // the measurement, and promotion is one use of it.
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

      if (channel.id !== channels.room.id) continue;
      if (db.query("SELECT 1 FROM promoted_deliveries WHERE delivery_id=?").get(delivery.id)) continue;

      let reason: PromotionContext["reason"] | null = null;
      let votes = readerVotes;
      if (readerVotes > 0) {
        const reactors = await read(
          `${API}/channels/${channel.channelId}/messages/${message.id}/reactions/${encodeURIComponent(rule.likeEmoji)}`,
          config,
          request,
          reactorsSchema,
        );
        if (reactors?.some((reactor) => reactor.id === rule.ownerUserId)) {
          reason = "owner";
          votes = 1;
        }
      }
      // A room that is arguing has not vouched for anything: the dislikes have to be the minority.
      if (!reason && readerVotes >= rule.readerVotes && votesFor(rule.dislikeEmoji) < readerVotes) reason = "readers";
      if (!reason) continue;

      const context: PromotionContext = { deliveryId: delivery.id, reason, votes };
      promotionContextSchema.parse(context);
      db.transaction(() => {
        const batch = db
          .query<{ id: number }, [string, string]>(
            "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES('scout-promotion',0,?,'promotion',?) RETURNING id",
          )
          .get(new Date(now).toISOString(), JSON.stringify(context));
        if (!batch) throw new Error("Promotion batch insert failed");
        for (const destination of channels.wire)
          db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
            batch.id,
            destination.id,
            JSON.stringify(destination),
          );
        db.query(
          "INSERT INTO promoted_deliveries(delivery_id,batch_id,reason,votes,promoted_at) VALUES(?,?,?,?,?)",
        ).run(delivery.id, batch.id, reason, votes, new Date(now).toISOString());
      })();
      promoted += 1;
    }
  }
  return promoted;
}
