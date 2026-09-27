/**
 * Publishing a board: one message per board, edited in place, and the state that makes that safe.
 *
 * What each board says is in src/boards/, one file per board plus one for what Discord accepts in
 * an embed. This file is the only part of it that reaches the network or writes a message id, which
 * is the boundary src/events/render/ keeps against delivery and for the same reason: something that
 * draws and can also send is something that can retry, and a board is a state in a channel rather
 * than a log precisely because nothing that draws one decides whether it goes.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { activityEmbed } from "./boards/activity.js";
import { coverageEmbed } from "./boards/coverage.js";
import { EMBED_CHARACTER_LIMIT, embedLength, fitEmbed } from "./boards/embed.js";
import { clearBoardFailure, recordBoardFailure } from "./boards/failures.js";
import { sourceHealth } from "./boards/health.js";
import type { BoardKey } from "./boards/keys.js";
import { platformEmbed } from "./boards/platforms.js";
import { releaseAuditEmbed } from "./boards/releases.js";
import { statusEmbed } from "./boards/statusBoard.js";
import { suppressionEmbed } from "./boards/suppressions.js";
import type { AppConfig } from "./config.js";
import { featureEnabled } from "./features.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { readState, writeState } from "./storage/appState.js";

const discordMessage = z.object({ id: z.string().regex(/^\d+$/) });
const DISCORD_TIMEOUT_MS = 20_000;
export type BoardResult = "skipped" | "created" | "edited" | "unchanged";

/**
 * The idempotency key for posting a board, in the 25 characters Discord allows a nonce.
 *
 * The previous spelling wrote the board's name and, when recreating one, the id of the message it
 * replaces -- twenty-nine characters for `suppressions` and about fifty once an id was appended, so
 * Discord answered 400 and the two longest-named boards could never be created at all. Everything
 * that identified the post still identifies it; it is hashed rather than spelled out.
 */
function boardNonce(key: string, comparable: string, previousMessageId: string | null): string {
  let hash = 2_166_136_261;
  for (const character of `${key}\u0000${comparable}\u0000${previousMessageId ?? ""}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `sf-board-${hash.toString(36)}`;
}

/**
 * A board is one message that is edited in place, so the channel holds a state rather than a log.
 * The rendered payload is compared before sending: a board that has not changed is not an event,
 * and editing it anyway would mark the channel unread for everyone watching it.
 */
async function sendBoard(
  db: Database,
  config: AppConfig,
  key: BoardKey,
  channelId: string,
  rendered: Record<string, unknown>,
  request: Fetch,
  now: number,
): Promise<BoardResult> {
  if (!config.DISCORD_BOT_TOKEN) return "skipped";
  const embed = fitEmbed(rendered);
  const size = embedLength(embed);
  // Nothing downstream of here can recover an embed Discord refuses, so it is refused here, where
  // the reason is still known. fitEmbed makes this unreachable; an unreachable case that is not
  // checked is how the board went quiet the first time.
  if (size > EMBED_CHARACTER_LIMIT) {
    log("error", "Board render exceeds Discord's embed limit", { board: key, characters: size });
    recordBoardFailure(db, key, `render is ${size} characters, above Discord's limit of ${EMBED_CHARACTER_LIMIT}`, now);
    return "unchanged";
  }
  const comparable = JSON.stringify({ ...embed, timestamp: undefined });
  const renderKey = `${key}_render`;
  const messageKey = `${key}_message`;
  const state = readState(db, renderKey);
  const messageId = readState(db, messageKey);
  if (state === comparable && messageId) {
    // An unchanged board still has to exist. Deleting one by hand is how its position in the
    // channel gets fixed, and without this check the board would never come back: the content
    // matches, so nothing would ever be sent again.
    const present = await request(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      redirect: "error",
    });
    await present.body?.cancel();
    if (present.ok) {
      clearBoardFailure(db, key);
      return "unchanged";
    }
  }

  const headers = {
    "content-type": "application/json",
    Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
  };
  const base = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const message = { embeds: [embed], allowed_mentions: { parse: [] } };
  const payload = JSON.stringify(message);
  // A timed-out create may already have reached Discord. Reusing the same nonce lets Discord
  // return the existing message instead of creating a second board on the next cycle. A confirmed
  // 404 includes the old message ID, so a hand-deleted board can still be recreated.
  const createPayload = JSON.stringify({
    ...message,
    nonce: boardNonce(key, comparable, messageId),
    enforce_nonce: true,
  });

  const remember = (id: string) => {
    writeState(db, messageKey, id);
    writeState(db, renderKey, comparable);
  };

  if (messageId) {
    const edited = await request(`${base}/${messageId}`, {
      method: "PATCH",
      headers,
      body: payload,
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      redirect: "error",
    });
    if (edited.ok) {
      remember(messageId);
      clearBoardFailure(db, key);
      return "edited";
    }
    // The board was deleted by hand; posting a fresh one is the recovery, not an error to retry.
    await edited.body?.cancel();
    if (edited.status !== 404) {
      log("warn", "Board edit rejected", { board: key, status: edited.status });
      // A rejected edit leaves the last version standing in the channel, which reads to everybody
      // as a board that is simply quiet. It is an actionable problem, and now it says so.
      recordBoardFailure(db, key, `Discord refused the edit with HTTP ${edited.status}`, now);
      return "unchanged";
    }
  }

  const created = await request(base, {
    method: "POST",
    headers,
    body: createPayload,
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    redirect: "error",
  });
  if (!created.ok) {
    await created.body?.cancel();
    log("warn", "Board post rejected", { board: key, status: created.status });
    recordBoardFailure(db, key, `Discord refused the post with HTTP ${created.status}`, now);
    return "unchanged";
  }
  const parsed = discordMessage.safeParse(await created.json().catch(() => null));
  if (!parsed.success) {
    log("warn", "Board response invalid", { board: key });
    recordBoardFailure(db, key, "Discord answered the post with a body this service could not read", now);
    return "unchanged";
  }
  remember(parsed.data.id);
  clearBoardFailure(db, key);
  return "created";
}

/**
 * The boards, in the order the channel reads them: what happened, then how the vendors are doing,
 * then how we are doing. Each is one message edited in place rather than reposted, so the channel
 * holds a board instead of a log; the rendered payload is compared before sending, because a
 * status that has not changed is not an event.
 */
const BOARDS: Record<
  BoardKey,
  {
    channel: (config: AppConfig) => string | null | undefined;
    embed: (db: Database, config: AppConfig, now: number) => Record<string, unknown>;
  }
> = {
  activity: {
    channel: (config) => config.platformBoardChannelId ?? config.statusChannelId,
    embed: (db, _config, now) => activityEmbed(db, now),
  },
  platforms: {
    channel: (config) => config.platformBoardChannelId ?? config.statusChannelId,
    embed: (db, _config, now) => platformEmbed(db, now),
  },
  suppressions: {
    channel: (config) => config.platformBoardChannelId ?? config.statusChannelId,
    embed: (db, _config, now) => suppressionEmbed(db, now),
  },
  coverage: {
    channel: (config) => config.platformBoardChannelId ?? config.statusChannelId,
    embed: (db, _config, now) => coverageEmbed(db, now),
  },
  releases: {
    channel: (config) => config.statusChannelId,
    embed: (db, _config, now) => releaseAuditEmbed(db, now),
  },
  status: {
    channel: (config) => config.statusChannelId,
    embed: (db, config, now) => statusEmbed(sourceHealth(db, config, now), now),
  },
};

export async function publishBoard(
  db: Database,
  config: AppConfig,
  key: BoardKey,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<BoardResult> {
  const board = BOARDS[key];
  const channelId = board.channel(config);
  if (!channelId || !config.DISCORD_BOT_TOKEN || !featureEnabled(config, "status-boards")) return "skipped";
  return sendBoard(db, config, key, channelId, board.embed(db, config, now), request, now);
}
