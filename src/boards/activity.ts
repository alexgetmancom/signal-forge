/**
 * The activity board: what happened in the last 24 hours, in counts a reader can check against the
 * channels. Facts only -- no model writes this one.
 */

import type { Database } from "bun:sqlite";
import { COLORS } from "./embed.js";

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
