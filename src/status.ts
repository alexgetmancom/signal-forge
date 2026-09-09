import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type CapabilityReportEntry, capabilityReport } from "./capabilities.js";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { PLATFORMS } from "./sources/platforms.js";
import { sourceJobs } from "./sources/registry.js";

/**
 * A source can be silent for three different reasons, and a status board that calls all three
 * "down" teaches readers to ignore it. Blocked is not broken: Gemini answers everywhere except the
 * addresses this project can reach, so it is reported as a restriction with its cause, not a fault.
 */
export type SourceState = "ok" | "stale" | "failing" | "blocked" | "idle";

export type SourceHealth = {
  id: string;
  label: string;
  group: string;
  state: SourceState;
  detail: string;
  lastSuccess: string | null;
  checkedAt: string | null;
};

/** A source is late once it has missed three of its own intervals — one slow cycle is not news. */
export function sourceHealth(db: Database, config: AppConfig, now = Date.now()): SourceHealth[] {
  return sourceJobs(db, config).map((job) => {
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
      .get(job.id);
    const group = job.group;
    const restriction = job.restrictedReason;

    if (!row?.checked_at)
      return {
        id: job.id,
        label: job.label,
        group,
        state: "idle",
        detail: "no observation yet",
        lastSuccess: row?.last_success ?? null,
        checkedAt: row?.checked_at ?? null,
      };
    const base = { lastSuccess: row.last_success, checkedAt: row.checked_at };
    if (row.last_error) {
      if (restriction) return { id: job.id, label: job.label, group, state: "blocked", detail: restriction, ...base };
      if (/bot protection|captcha|challenge/i.test(row.last_error))
        return {
          id: job.id,
          label: job.label,
          group,
          state: "blocked",
          detail: "upstream bot protection — waiting for a readable status response",
          ...base,
        };
      if (/HTTP 429$/.test(row.last_error))
        return {
          id: job.id,
          label: job.label,
          group,
          state: "blocked",
          detail: row.retry_at ? `rate limited — waiting until ${row.retry_at}` : "rate limited — backing off",
          ...base,
        };
      return { id: job.id, label: job.label, group, state: "failing", detail: row.last_error, ...base };
    }
    const since = row.last_success ? now - Date.parse(row.last_success) : Number.POSITIVE_INFINITY;
    if (since > job.interval * 3000)
      return { id: job.id, label: job.label, group, state: "stale", detail: "no fresh observation", ...base };
    return { id: job.id, label: job.label, group, state: "ok", detail: "", ...base };
  });
}

const DOTS: Record<SourceState, string> = {
  ok: "🟢",
  stale: "🟡",
  failing: "🔴",
  blocked: "🔵",
  idle: "⚪",
};

const COLORS = { ok: 0x2ecc71, degraded: 0xf1c40f, down: 0xe74c3c };
const discordMessage = z.object({ id: z.string().regex(/^\d+$/) });
const DISCORD_TIMEOUT_MS = 20_000;

export type DeliverySummary = {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  ambiguous: number;
  verification_required: number;
};

function utcStamp(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function deliverySummary(db: Database): DeliverySummary {
  const summary: DeliverySummary = {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    verification_required: 0,
  };
  const rows = db
    .query<{ status: string; count: number }, []>("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status")
    .all();
  for (const row of rows) {
    if (Object.hasOwn(summary, row.status)) summary[row.status as keyof DeliverySummary] = row.count;
  }
  return summary;
}

export function statusEmbed(
  health: SourceHealth[],
  now = Date.now(),
  delivery?: DeliverySummary,
  capabilities?: CapabilityReportEntry[],
): Record<string, unknown> {
  const failing = health.filter((entry) => entry.state === "failing" || entry.state === "stale");
  const blocked = health.filter((entry) => entry.state === "blocked");
  const headline =
    failing.length === 0
      ? `${DOTS.ok} All collectors reporting`
      : `${DOTS.failing} ${failing.length} of ${health.length} collectors need attention`;

  const groups = [...new Set(health.map((entry) => entry.group))];
  const fields = groups.map((group) => ({
    name: group,
    value: health
      .filter((entry) => entry.group === group)
      .map((entry) => {
        const last = entry.lastSuccess ? ` · last success ${utcStamp(entry.lastSuccess)}` : "";
        return `${DOTS[entry.state]} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}${last}`;
      })
      .join("\n")
      .slice(0, 1024),
    inline: false,
  }));

  if (delivery)
    fields.push({
      name: "Delivery",
      value: [
        `pending ${delivery.pending}`,
        `sending ${delivery.sending}`,
        `sent ${delivery.sent}`,
        `failed ${delivery.failed}`,
        `ambiguous ${delivery.ambiguous + delivery.verification_required}`,
      ].join(" · "),
      inline: false,
    });
  const unavailable = capabilities?.filter((entry) => entry.status !== "ready") ?? [];
  if (unavailable.length)
    fields.push({
      name: "Integrations",
      value: unavailable
        .map((entry) => `${entry.status} · ${entry.id}`)
        .join("\n")
        .slice(0, 1024),
      inline: false,
    });

  return {
    title: "Tracker status",
    description: `${headline}${blocked.length ? `\n${DOTS.blocked} ${blocked.length} waiting on upstream` : ""}`,
    color:
      failing.length === 0 ? COLORS.ok : failing.some((e) => e.state === "failing") ? COLORS.down : COLORS.degraded,
    fields,
    footer: { text: "Signal Forge · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}

/**
 * One message that is edited rather than reposted, so the channel holds a board instead of a log.
 * The rendered payload is compared before sending: a status that has not changed is not an event.
 */
export async function publishStatus(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<BoardResult> {
  if (!config.statusChannelId || !config.DISCORD_BOT_TOKEN) return "skipped";
  return publishBoard(
    db,
    config,
    "status",
    config.statusChannelId,
    statusEmbed(sourceHealth(db, config, now), now, deliverySummary(db), capabilityReport(db, config)),
    request,
  );
}

export type BoardResult = "skipped" | "created" | "edited" | "unchanged";

/**
 * A board is one message that is edited in place, so the channel holds a state rather than a log.
 * The rendered payload is compared before sending: a board that has not changed is not an event,
 * and editing it anyway would mark the channel unread for everyone watching it.
 */
async function publishBoard(
  db: Database,
  config: AppConfig,
  key: string,
  channelId: string,
  embed: Record<string, unknown>,
  request: Fetch = fetch,
): Promise<BoardResult> {
  if (!config.DISCORD_BOT_TOKEN) return "skipped";
  const comparable = JSON.stringify({ ...embed, timestamp: undefined });
  const renderKey = `${key}_render`;
  const messageKey = `${key}_message`;
  const state = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(renderKey);
  const messageId = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(messageKey);
  if (state?.value === comparable && messageId) {
    // An unchanged board still has to exist. Deleting one by hand is how its position in the
    // channel gets fixed, and without this check the board would never come back: the content
    // matches, so nothing would ever be sent again.
    const present = await request(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId.value}`, {
      headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      redirect: "error",
    });
    await present.body?.cancel();
    if (present.ok) return "unchanged";
  }

  const headers = {
    "content-type": "application/json",
    Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
  };
  const base = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const payload = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });

  const remember = (id: string) => {
    db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      messageKey,
      id,
    );
    db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      renderKey,
      comparable,
    );
  };

  if (messageId) {
    const edited = await request(`${base}/${messageId.value}`, {
      method: "PATCH",
      headers,
      body: payload,
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      redirect: "error",
    });
    if (edited.ok) {
      remember(messageId.value);
      return "edited";
    }
    // The board was deleted by hand; posting a fresh one is the recovery, not an error to retry.
    if (edited.status !== 404) {
      log("warn", "Board edit rejected", { board: key, status: edited.status });
      return "unchanged";
    }
  }

  const created = await request(base, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    redirect: "error",
  });
  if (!created.ok) {
    log("warn", "Board post rejected", { board: key, status: created.status });
    return "unchanged";
  }
  const parsed = discordMessage.safeParse(await created.json().catch(() => null));
  if (!parsed.success) {
    log("warn", "Board response invalid", { board: key });
    return "unchanged";
  }
  remember(parsed.data.id);
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
    const row = db
      .query<{ raw_json: string }, [string]>("SELECT raw_json FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1")
      .get(`status:${platform.id}`);
    if (!row) {
      lines.push(`⚪ **${platform.name}** — not read yet`);
      continue;
    }
    const raw = JSON.parse(row.raw_json) as {
      headline?: string;
      indicator?: string;
      incidents?: { name: string; status: string; impact: string }[];
    };
    const indicator = raw.indicator ?? "none";
    if ((INDICATOR_RANK[indicator] ?? 0) > (INDICATOR_RANK[worst] ?? 0)) worst = indicator;
    lines.push(`${INDICATORS[indicator] ?? "⚪"} **${platform.name}** — ${raw.headline ?? "unknown"}`);
    for (const incident of (raw.incidents ?? []).slice(0, 3))
      lines.push(`　└ ${incident.name} (${incident.status}, ${incident.impact})`);
  }
  return {
    title: "Platform health",
    description: lines.join("\n").slice(0, 4000),
    color: worst === "none" ? COLORS.ok : worst === "critical" || worst === "major" ? COLORS.down : COLORS.degraded,
    footer: { text: "Read from each vendor's own status page · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}

export async function publishPlatformBoard(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<BoardResult> {
  const channelId = config.platformBoardChannelId ?? config.statusChannelId;
  if (!channelId || !config.DISCORD_BOT_TOKEN) return "skipped";
  return publishBoard(db, config, "platforms", channelId, platformEmbed(db, now), request);
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
  const weights = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='weights'", since);
  const news = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='news'", since);
  const arenaChanges = count(
    "SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='arena' AND kind='changed'",
    since,
  );
  const retirements = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='deprecations'", since);
  const incidents = count("SELECT COUNT(*) c FROM events WHERE detected_at > ? AND stream='incidents'", since);

  const lines = [
    `**${models}** new models · **${gone}** withdrawn · **${modelChanges}** catalogue changes`,
    `**${weights}** open-weight releases · **${arenaChanges}** Arena changes`,
    `**${news}** announcements · **${retirements}** retirement updates · **${incidents}** platform incidents`,
  ];
  const headline = db
    .query<{ id: number; name: string }, [string]>(
      `SELECT id, json_extract(after_json,'$.name') name FROM events
       WHERE detected_at > ? AND kind='new' AND stream IN ('api-models','openrouter','weights')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(since);
  if (headline?.name) lines.push("", `Latest: ${headline.name} (#${headline.id})`);
  return {
    title: "Last 24 hours",
    description: lines.join("\n"),
    color: COLORS.ok,
    footer: { text: "Counts from the feed itself · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}

export async function publishActivityBoard(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<BoardResult> {
  const channelId = config.platformBoardChannelId ?? config.statusChannelId;
  if (!channelId || !config.DISCORD_BOT_TOKEN) return "skipped";
  return publishBoard(db, config, "activity", channelId, activityEmbed(db, now), request);
}
