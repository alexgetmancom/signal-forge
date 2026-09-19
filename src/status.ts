import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, SourceMode } from "./config.js";
import { COLLECTION_DEGRADED_PREFIX } from "./events/store.js";
import type { SourceAuthority } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { sourceLabel } from "./sources/labels.js";
import { PLATFORMS } from "./sources/platforms.js";
import { buildSourceRegistry } from "./sources/registry.js";
import { clearState, readState, writeState } from "./storage/appState.js";
import { readLatestSnapshot } from "./storage/snapshots.js";
import { clip } from "./text.js";

/**
 * A source can be silent for several different reasons, and a status board that calls all of them
 * "down" teaches readers to ignore it. Blocked is not broken: Gemini answers everywhere except
 * the addresses this project can reach, so it is reported as a restriction with its cause, not a fault.
 */
type SourceState = "ok" | "stale" | "failing" | "degraded" | "blocked" | "idle" | "missing" | "disabled";

export type SourceHealth = {
  id: string;
  label: string;
  group: string;
  authority: SourceAuthority;
  mode: SourceMode;
  state: SourceState;
  detail: string;
  lastSuccess: string | null;
  checkedAt: string | null;
};

/** A source is late once it has missed three of its own intervals — one slow cycle is not news. */
export function sourceHealth(db: Database, config: AppConfig, now = Date.now()): SourceHealth[] {
  const values = config as unknown as Record<string, unknown>;
  return buildSourceRegistry(db, config).map((source) => {
    const sourceBase = {
      id: source.id,
      label: source.label,
      group: source.group,
      authority: source.authority,
      mode: source.mode,
    };
    const missing = (source.requiredCapabilities ?? []).filter((name) => !values[name]);
    if (!source.enabled)
      return {
        ...sourceBase,
        state: "disabled",
        detail: "disabled by configuration",
        lastSuccess: null,
        checkedAt: null,
      } satisfies SourceHealth;
    if (missing.length)
      return {
        ...sourceBase,
        state: "missing",
        detail: `missing ${missing.join(", ")}`,
        lastSuccess: null,
        checkedAt: null,
      } satisfies SourceHealth;

    const row = db
      .query<
        {
          last_success: string | null;
          last_error: string | null;
          checked_at: string | null;
          retry_at: string | null;
        },
        [string]
      >("SELECT last_success,last_error,checked_at,retry_at FROM sources WHERE id=?")
      .get(source.id);
    const group = source.group;
    const restriction = source.restrictedReason;

    if (!row?.checked_at)
      return {
        ...sourceBase,
        group,
        state: "idle",
        detail: "no observation yet",
        lastSuccess: row?.last_success ?? null,
        checkedAt: row?.checked_at ?? null,
      };
    const observationBase = { lastSuccess: row.last_success, checkedAt: row.checked_at };
    if (row.last_error) {
      if (row.last_error.startsWith(COLLECTION_DEGRADED_PREFIX))
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "degraded",
          detail: row.last_error,
        };
      if (restriction)
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: restriction,
        };
      if (/bot protection|captcha|challenge/i.test(row.last_error))
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: "upstream bot protection — waiting for a readable status response",
        };
      if (/HTTP 429$/.test(row.last_error))
        return {
          ...sourceBase,
          ...observationBase,
          group,
          state: "blocked",
          detail: row.retry_at ? `rate limited — waiting until ${row.retry_at}` : "rate limited — backing off",
        };
      return {
        ...sourceBase,
        ...observationBase,
        group,
        state: "failing",
        detail: row.last_error,
      };
    }
    const since = row.last_success ? now - Date.parse(row.last_success) : Number.POSITIVE_INFINITY;
    if (since > source.intervalSeconds * 3000)
      return {
        ...sourceBase,
        ...observationBase,
        group,
        state: "stale",
        detail: "no fresh observation",
      };
    return { ...sourceBase, ...observationBase, group, state: "ok", detail: "" };
  });
}

const DOTS: Record<SourceState, string> = {
  ok: "🟢",
  stale: "🟡",
  failing: "🔴",
  degraded: "🟡",
  blocked: "🔵",
  idle: "⚪",
  missing: "🟣",
  disabled: "⚫",
};

const COLORS = { ok: 0x2ecc71, degraded: 0xf1c40f, down: 0xe74c3c };
const discordMessage = z.object({ id: z.string().regex(/^\d+$/) });
const DISCORD_TIMEOUT_MS = 20_000;
/**
 * Discord's own limits on one embed. They are not advisory: an embed one character over is a 400,
 * and a board that cannot be edited freezes at whatever it last said. The status board crossed 6000
 * characters at 104 visible collectors and stopped moving, which nothing noticed for as long as it
 * took somebody to read the timestamps on it.
 */
const EMBED_CHARACTER_LIMIT = 6000;
const EMBED_FIELD_LIMIT = 25;
const FIELD_VALUE_LIMIT = 1024;
const DESCRIPTION_LIMIT = 4096;

type EmbedField = { name: string; value: string; inline: boolean };

function embedLength(embed: Record<string, unknown>): number {
  const text = (value: unknown) => (typeof value === "string" ? value.length : 0);
  const fields = (embed.fields as EmbedField[] | undefined) ?? [];
  return (
    text(embed.title) +
    text(embed.description) +
    text((embed.footer as { text?: string } | undefined)?.text) +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/**
 * The last thing a board passes through, so no render can exceed what Discord accepts. Trimming
 * loses information and says so in the board itself; the alternative is an embed that is rejected
 * whole, which loses all of it silently.
 */
export function fitEmbed(embed: Record<string, unknown>): Record<string, unknown> {
  const fitted = { ...embed };
  if (typeof fitted.description === "string") fitted.description = clip(fitted.description, DESCRIPTION_LIMIT);
  const fields = (
    ((fitted.fields as EmbedField[] | undefined) ?? []).map((field) => ({
      ...field,
      value: clip(field.value, FIELD_VALUE_LIMIT),
    })) satisfies EmbedField[]
  ).slice();

  let dropped = 0;
  const marker = (count: number): EmbedField => ({
    name: "…",
    value: `${count} more section${count === 1 ? "" : "s"} not shown — run \`status\` for the full list`,
    inline: false,
  });
  const reserve = marker(fields.length).name.length + marker(fields.length).value.length;
  // Nothing is dropped when everything fits; the marker's room is only reserved once it is needed.
  const fits = fields.length <= EMBED_FIELD_LIMIT && embedLength({ ...fitted, fields }) <= EMBED_CHARACTER_LIMIT;
  while (
    !fits &&
    fields.length > 0 &&
    (fields.length + 1 > EMBED_FIELD_LIMIT ||
      // The marker is appended after the loop, so its room is kept on every pass, not only the first:
      // releasing it once a section was dropped let a 6,038-character board through on 2026-09-17.
      embedLength({ ...fitted, fields }) + reserve > EMBED_CHARACTER_LIMIT)
  ) {
    fields.pop();
    dropped += 1;
  }
  if (dropped) fields.push(marker(dropped));
  fitted.fields = fields;
  return fitted;
}

function utcStamp(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function statusEmbed(health: SourceHealth[], now = Date.now()): Record<string, unknown> {
  const failing = health.filter(
    (entry) => entry.state === "failing" || entry.state === "stale" || entry.state === "degraded",
  );
  const blocked = health.filter((entry) => entry.state === "blocked");
  const unavailable = health.filter((entry) => entry.state === "missing" || entry.state === "disabled");
  const activeCount = health.length - unavailable.length;
  const headline =
    failing.length === 0
      ? `${DOTS.ok} ${activeCount} active collectors reporting`
      : `${DOTS.failing} ${failing.length} of ${activeCount} active collectors need attention`;

  const visibleHealth = health.filter((entry) => entry.state !== "missing" && entry.state !== "disabled");
  // fitEmbed drops the last sections once the board is full, so a group with a collector that needs
  // attention comes first: adding the Hugging Face router pushed a failing Arena off the board.
  const groups = [...new Set(visibleHealth.map((entry) => entry.group))].sort(
    (left, right) =>
      Number(visibleHealth.some((entry) => entry.group === right && entry.state !== "ok")) -
      Number(visibleHealth.some((entry) => entry.group === left && entry.state !== "ok")),
  );
  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const group of groups) {
    const rows = health
      .filter((entry) => entry.group === group && entry.state !== "missing" && entry.state !== "disabled")
      .map((entry) => {
        // A green collector is green because it was observed within its own schedule, so its
        // authority and its timestamp say nothing its dot did not. Spelling them out for every
        // healthy source is what pushed this embed past what Discord accepts; the sources that
        // need a reader's attention keep every word of it.
        if (entry.state === "ok") return `${DOTS.ok} ${entry.label}`;
        const last = entry.lastSuccess ? ` · ${utcStamp(entry.lastSuccess)}` : "";
        return `${DOTS[entry.state]} ${entry.label} · ${entry.authority.replace("_", "-")}${entry.detail ? ` — ${entry.detail}` : ""}${last}`;
      });
    let page = 1;
    let value = "";
    for (const row of rows) {
      const next = value ? `${value}\n${row}` : row;
      if (value && next.length > 1024) {
        fields.push({ name: page === 1 ? group : `${group} (${page})`, value, inline: false });
        page += 1;
        value = row;
      } else value = next;
    }
    if (value) fields.push({ name: page === 1 ? group : `${group} (${page})`, value, inline: false });
  }

  return {
    title: "Tracker status",
    description: `${headline}${blocked.length ? `\n${DOTS.blocked} ${blocked.length} waiting on upstream` : ""}${unavailable.length ? `\n${DOTS.missing} ${unavailable.length} sources outside current coverage` : ""}`,
    color:
      failing.length === 0 ? COLORS.ok : failing.some((e) => e.state === "failing") ? COLORS.down : COLORS.degraded,
    fields,
    footer: { text: "Signal Forge · green means observed on schedule · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}

export type BoardResult = "skipped" | "created" | "edited" | "unchanged";

const BOARD_FAILURE_PREFIX = "board_failure:";
export type BoardFailure = { board: BoardKey; reason: string; firstSeenAt: string; updatedAt: string };

/**
 * A board that cannot be sent is the one failure this service used to keep to itself: the channel
 * still holds a plausible board, and a stale board looks exactly like a quiet one. Storing the
 * refusal is what lets `issues` and the alert channel say it out loud.
 */
function recordBoardFailure(db: Database, board: BoardKey, reason: string, now: number): void {
  const key = `${BOARD_FAILURE_PREFIX}${board}`;
  const existing = readState(db, key);
  let firstSeenAt = new Date(now).toISOString();
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<BoardFailure>;
      if (parsed.firstSeenAt && Number.isFinite(Date.parse(parsed.firstSeenAt))) firstSeenAt = parsed.firstSeenAt;
    } catch {
      // A value this service cannot read is replaced by one it can.
    }
  }
  const value = JSON.stringify({ board, reason, firstSeenAt, updatedAt: new Date(now).toISOString() });
  writeState(db, key, value);
}

function clearBoardFailure(db: Database, board: BoardKey): void {
  clearState(db, `${BOARD_FAILURE_PREFIX}${board}`);
}

/** Every board Discord is currently refusing, for the read model that has to report it. */
export function boardFailures(db: Database): BoardFailure[] {
  return db
    .query<{ key: string; value: string }, [string]>("SELECT key,value FROM app_state WHERE key LIKE ? ORDER BY key")
    .all(`${BOARD_FAILURE_PREFIX}%`)
    .flatMap((row) => {
      try {
        const parsed = JSON.parse(row.value) as BoardFailure;
        return parsed.board && parsed.reason ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

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

const INDICATORS: Record<string, string> = {
  none: "🟢",
  minor: "🟡",
  major: "🟠",
  critical: "🔴",
  maintenance: "🔵",
};
const INDICATOR_RANK: Record<string, number> = { none: 0, maintenance: 1, minor: 2, major: 3, critical: 4 };

/** What each platform's own status page says right now, read from the stored observation. */
export function platformEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const lines: string[] = [];
  let worst = "none";
  for (const platform of PLATFORMS) {
    const payload = readLatestSnapshot(db, `status:${platform.id}`);
    if (!payload) {
      lines.push(`⚪ **${platform.name}** — not read yet`);
      continue;
    }
    const raw = JSON.parse(payload) as {
      headline?: string;
      indicator?: string;
      incidents?: { name: string; status: string; impact: string }[];
    };
    const indicator = raw.indicator ?? "none";
    // An indicator this board does not know is not a healthy one: it reads as degraded until named.
    if ((INDICATOR_RANK[indicator] ?? INDICATOR_RANK.minor ?? 0) > (INDICATOR_RANK[worst] ?? 0)) worst = indicator;
    lines.push(`${INDICATORS[indicator] ?? "⚪"} **${platform.name}** — ${raw.headline ?? "unknown"}`);
    for (const incident of (raw.incidents ?? []).slice(0, 3))
      lines.push(`　└ ${incident.name} (${incident.status}, ${incident.impact})`);
  }
  return {
    title: "Platform health",
    description: clip(lines.join("\n"), 4000),
    color: worst === "none" ? COLORS.ok : worst === "critical" || worst === "major" ? COLORS.down : COLORS.degraded,
    footer: { text: "Read from each vendor's own status page · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}

/**
 * The board a reader looks at first: what actually happened today, in counts they can check
 * against the channels. Facts only — no model writes this one, because a headline that cannot be
 * verified against the feed underneath it is worth less than no headline.
 */
export function activityEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const count = (sql: string, ...params: string[]) =>
    Number(db.query<{ c: number }, string[]>(sql).get(...params)?.c ?? 0);

  const models = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND kind='new' AND stream IN ('api-models','openrouter')",
    since,
  );
  const gone = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND kind='removed' AND stream IN ('api-models','openrouter')",
    since,
  );
  const modelChanges = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND kind='changed' AND stream IN ('api-models','openrouter')",
    since,
  );
  // Shadow discovery scans every fresh community upload to find candidates worth watching. Those
  // are leads, not releases: counting them told a reader 3200 open-weight releases in a day.
  const weights = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='weights' AND source NOT LIKE 'discovery:%'",
    since,
  );
  const news = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='news'", since);
  // What matters on the Arena is which models appeared and which are gone; scores and votes move
  // constantly and were the only thing this line used to count, so it read "0" on a busy day.
  const arenaNew = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='arena' AND kind='new'",
    since,
  );
  const arenaGone = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='arena' AND kind='removed'",
    since,
  );
  const retirements = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='deprecations'", since);
  const incidents = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='incidents'", since);

  const lines = [
    `**${models}** new models · **${gone}** withdrawn · **${modelChanges}** catalogue changes`,
    `**${weights}** open-weight releases · **${arenaNew}** new on Arena · **${arenaGone}** gone from Arena`,
    `**${news}** announcements · **${retirements}** retirement updates · **${incidents}** platform incidents`,
  ];
  const headline = db
    .query<{ name: string; url: string }, [string]>(
      `SELECT json_extract(e.after_json,'$.name') name,
              COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),be.url) AS url
       FROM events e JOIN batch_events be ON be.event_id=e.id
       WHERE e.detected_at > ? AND e.kind='new' AND e.stream IN ('api-models','openrouter','weights')
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(since);
  const embed: Record<string, unknown> = {
    title: "Last 24 hours",
    description: lines.join("\n"),
    color: COLORS.ok,
    footer: { text: "Observed event counts · routine changes may appear in the hourly digest" },
    timestamp: new Date(now).toISOString(),
  };
  if (headline?.name && headline.url) {
    embed.description = `${lines.concat("", `Latest: **${headline.name}** · [open source](${headline.url})`).join("\n")}`;
    embed.url = headline.url;
  }
  return embed;
}

/**
 * What the filters stopped, so the operator can see whether they are set too tight.
 *
 * Every suppressed event carries the rule that stopped it and the same decision in a reader's
 * words. Counting them is the only way to answer "why was the digest empty?" without replaying a
 * day of events by hand, and a filter that starts eating real news shows up here as a reason
 * climbing rather than as silence nobody notices.
 */
export function suppressionEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const reasons = db
    .query<{ reason: string; c: number }, [string]>(
      "SELECT reason,COUNT(*) c FROM suppressions WHERE recorded_at > ? GROUP BY reason ORDER BY c DESC",
    )
    .all(since);
  const sources = db
    .query<{ source: string; c: number }, [string]>(
      `SELECT e.source source,COUNT(*) c FROM suppressions s JOIN events e ON e.id=s.event_id
       WHERE s.recorded_at > ? GROUP BY e.source ORDER BY c DESC LIMIT 5`,
    )
    .all(since);
  // An event sitting in a delivered batch did not necessarily appear in the message: the batch is
  // filtered again at render time. Only an event with no suppression row against it actually spoke.
  const spoken = Number(
    db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(DISTINCT be.event_id) c FROM batch_events be
         JOIN deliveries d ON d.batch_id=be.batch_id AND d.status='sent'
         JOIN events e ON e.id=be.event_id
         WHERE e.detected_at > ?
           AND NOT EXISTS (SELECT 1 FROM suppressions s
                           WHERE s.event_id=be.event_id AND s.destination_id=d.destination_id)`,
      )
      .get(since)?.c ?? 0,
  );
  const total = reasons.reduce((sum, row) => sum + row.c, 0);
  const readable = (reason: string) => reason.replace(/_/g, " ");
  const lines = total
    ? [
        `**${total}** events held back · **${spoken}** reached a channel`,
        "",
        ...reasons.map((row) => `**${row.c}** · ${readable(row.reason)}`),
        "",
        `Loudest: ${sources.map((row) => `${sourceLabel(row.source)} (${row.c})`).join(" · ")}`,
      ]
    : [`Nothing was held back · **${spoken}** events reached a channel`];
  return {
    title: "Filtered out, last 24 hours",
    description: lines.join("\n"),
    color: COLORS.ok,
    footer: { text: "Run `suppressions` for the individual decisions and the reason each one carries" },
    timestamp: new Date(now).toISOString(),
  };
}

export type BoardKey = "activity" | "platforms" | "suppressions" | "status";

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
  status: {
    channel: (config) => config.statusChannelId,
    embed: (db, config, now) => statusEmbed(sourceHealth(db, config, now), now),
  },
};

export const BOARD_ORDER: readonly BoardKey[] = ["activity", "platforms", "suppressions", "status"];

export async function publishBoard(
  db: Database,
  config: AppConfig,
  key: BoardKey,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<BoardResult> {
  const board = BOARDS[key];
  const channelId = board.channel(config);
  if (!channelId || !config.DISCORD_BOT_TOKEN) return "skipped";
  return sendBoard(db, config, key, channelId, board.embed(db, config, now), request, now);
}
