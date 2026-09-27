/**
 * The suppression board: what the filters stopped, so a filter set too tight shows up here as a
 * reason climbing rather than as a digest nobody can explain the emptiness of.
 */

import type { Database } from "bun:sqlite";
import { sourceLabel } from "../sources/labels.js";
import { COLORS } from "./embed.js";

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
