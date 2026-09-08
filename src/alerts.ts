import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./delivery.js";
import { log } from "./logger.js";
import { sourceHealth } from "./status.js";

/**
 * The status board is passive: it shows the truth to whoever opens the channel. A collector that
 * dies quietly can therefore stay dead for days, and silence in the feed reads to subscribers as
 * "nothing is happening" rather than "nothing is being collected". This sends the one message the
 * board cannot: a source went down, and later, a source came back.
 */

/** Alerting only on these states; `blocked` is a known restriction and `idle` is a fresh source. */
const ALERTING = new Set(["failing", "stale"]);

/**
 * A source must be down for two consecutive checks — ten minutes — before it is announced. Today's
 * outages lasted five to seven minutes and cleared themselves; alerting on the first failed cycle
 * turned one broken network path into four messages about six collectors, which is how an alert
 * channel becomes something people mute.
 */
const CONFIRMATIONS = 2;

/**
 * Above this, the sources are not individually broken — something they share is. Naming twenty
 * collectors teaches nothing that "twenty at once" does not.
 */
const PATH_OUTAGE = 4;

export type AlertOutcome = { down: string[]; recovered: string[]; posted: boolean };

export async function publishAlerts(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<AlertOutcome> {
  const outcome: AlertOutcome = { down: [], recovered: [], posted: false };
  if (!config.alertChannelId || !config.DISCORD_BOT_TOKEN) return outcome;

  const health = sourceHealth(db, config, now);
  const stored = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get("alert_down");
  const previous = new Set<string>(stored ? (JSON.parse(stored.value) as string[]) : []);
  const failing = health.filter((entry) => ALERTING.has(entry.state)).map((entry) => entry.id);

  // Count consecutive failed checks per source, so a blip has to persist to become an alert.
  const strikesRow = db
    .query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?")
    .get("alert_strikes");
  const strikes: Record<string, number> = strikesRow ? (JSON.parse(strikesRow.value) as Record<string, number>) : {};
  const nextStrikes: Record<string, number> = {};
  for (const id of failing) nextStrikes[id] = (strikes[id] ?? 0) + 1;
  const value = JSON.stringify(nextStrikes);
  db.query("INSERT INTO app_state(key,value) VALUES('alert_strikes',?) ON CONFLICT(key) DO UPDATE SET value=?").run(
    value,
    value,
  );
  const current = new Set(failing.filter((id) => (nextStrikes[id] ?? 0) >= CONFIRMATIONS));

  const detail = new Map(health.map((entry) => [entry.id, entry.detail]));
  outcome.down = [...current].filter((id) => !previous.has(id));
  outcome.recovered = [...previous].filter((id) => !current.has(id));

  const remember = () => {
    const value = JSON.stringify([...current].sort());
    db.query("INSERT INTO app_state(key,value) VALUES('alert_down',?) ON CONFLICT(key) DO UPDATE SET value=?").run(
      value,
      value,
    );
  };
  // A state that has not moved is not an alert: the same outage is reported once, not every cycle.
  if (!outcome.down.length && !outcome.recovered.length) {
    remember();
    return outcome;
  }

  const lines =
    outcome.down.length >= PATH_OUTAGE
      ? [
          `🔴 **${outcome.down.length} collectors stopped reporting at once** — this is one shared path, not ${outcome.down.length} broken sources.`,
          outcome.down.slice(0, 6).join(", ") + (outcome.down.length > 6 ? ", …" : ""),
          ...outcome.recovered.map((id) => `🟢 **${id}** is reporting again`),
        ]
      : [
          ...outcome.down.map((id) => `🔴 **${id}** stopped reporting — ${detail.get(id) || "no detail"}`),
          ...outcome.recovered.map((id) => `🟢 **${id}** is reporting again`),
        ];
  const embed = {
    title: outcome.down.length ? "Collector problem" : "Collectors recovered",
    description: lines.join("\n").slice(0, 4000),
    color: outcome.down.length ? 0xe74c3c : 0x2ecc71,
    footer: { text: `${current.size} of ${health.length} collectors down` },
    timestamp: new Date(now).toISOString(),
  };
  const response = await request(`https://discord.com/api/v10/channels/${config.alertChannelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) {
    // Leaving the stored set untouched means the next cycle tries again rather than losing the
    // transition; an alert that cannot be delivered must not be silently forgotten.
    log("warn", "Alert rejected", { status: response.status });
    return outcome;
  }
  await response.body?.cancel();
  remember();
  outcome.posted = true;
  return outcome;
}
