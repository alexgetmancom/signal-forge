import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./delivery.js";
import { log } from "./logger.js";
import { sourceJobs } from "./poller.js";

/**
 * A source can be silent for three different reasons, and a status board that calls all three
 * "down" teaches readers to ignore it. Blocked is not broken: Gemini answers everywhere except the
 * addresses this project can reach, so it is reported as a restriction with its cause, not a fault.
 */
export type SourceState = "ok" | "stale" | "failing" | "blocked" | "idle";

export type SourceHealth = {
  id: string;
  group: string;
  state: SourceState;
  detail: string;
};

/** Restrictions we have measured, so the board explains rather than blaming the collector. */
const RESTRICTED: Record<string, string> = {
  gemini: "region-locked: Google refuses every exit we have",
};

const GROUPS: [RegExp, string][] = [
  [/^(openrouter|openai|anthropic|gemini)$/, "Catalogues"],
  [/^arena/, "Arena"],
  [/news$/, "Official news"],
  [/^(claude-web|codex-docs)$/, "Web"],
  [/^github:/, "GitHub"],
];

function groupOf(id: string): string {
  return GROUPS.find(([pattern]) => pattern.test(id))?.[1] ?? "Other";
}

/** A source is late once it has missed three of its own intervals — one slow cycle is not news. */
export function sourceHealth(db: Database, config: AppConfig, now = Date.now()): SourceHealth[] {
  return sourceJobs(db, config).map((job) => {
    const row = db
      .query<{ last_success: string | null; last_error: string | null; checked_at: string | null }, [string]>(
        "SELECT last_success,last_error,checked_at FROM sources WHERE id=?",
      )
      .get(job.id);
    const group = groupOf(job.id);
    const restriction = RESTRICTED[job.id];

    if (!row?.checked_at) return { id: job.id, group, state: "idle", detail: "no observation yet" };
    if (row.last_error) {
      if (restriction) return { id: job.id, group, state: "blocked", detail: restriction };
      return { id: job.id, group, state: "failing", detail: row.last_error };
    }
    const since = row.last_success ? now - Date.parse(row.last_success) : Number.POSITIVE_INFINITY;
    if (since > job.interval * 3000) return { id: job.id, group, state: "stale", detail: "no fresh observation" };
    return { id: job.id, group, state: "ok", detail: "" };
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

export function statusEmbed(health: SourceHealth[], now = Date.now()): Record<string, unknown> {
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
      .map((entry) => `${DOTS[entry.state]} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ""}`)
      .join("\n")
      .slice(0, 1024),
    inline: false,
  }));

  return {
    title: "Tracker status",
    description: `${headline}${blocked.length ? `\n${DOTS.blocked} ${blocked.length} restricted, not broken` : ""}`,
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
): Promise<"skipped" | "created" | "edited" | "unchanged"> {
  if (!config.statusChannelId || !config.DISCORD_BOT_TOKEN) return "skipped";

  const embed = statusEmbed(sourceHealth(db, config, now), now);
  const comparable = JSON.stringify({ ...embed, timestamp: undefined });
  const state = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get("status_render");
  const messageId = db
    .query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?")
    .get("status_message");
  if (state?.value === comparable && messageId) return "unchanged";

  const headers = {
    "content-type": "application/json",
    Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
  };
  const base = `https://discord.com/api/v10/channels/${config.statusChannelId}/messages`;
  const payload = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });

  const remember = (id: string) => {
    db.query("INSERT INTO app_state(key,value) VALUES('status_message',?) ON CONFLICT(key) DO UPDATE SET value=?").run(
      id,
      id,
    );
    db.query("INSERT INTO app_state(key,value) VALUES('status_render',?) ON CONFLICT(key) DO UPDATE SET value=?").run(
      comparable,
      comparable,
    );
  };

  if (messageId) {
    const edited = await request(`${base}/${messageId.value}`, { method: "PATCH", headers, body: payload });
    if (edited.ok) {
      remember(messageId.value);
      return "edited";
    }
    // The board was deleted by hand; posting a fresh one is the recovery, not an error to retry.
    if (edited.status !== 404) {
      log("warn", "Status board edit rejected", { status: edited.status });
      return "unchanged";
    }
  }

  const created = await request(base, { method: "POST", headers, body: payload });
  if (!created.ok) {
    log("warn", "Status board post rejected", { status: created.status });
    return "unchanged";
  }
  const body = (await created.json()) as { id?: unknown };
  if (typeof body.id === "string") remember(body.id);
  return "created";
}
