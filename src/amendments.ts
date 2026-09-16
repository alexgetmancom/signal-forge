import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { incidentEnded } from "./events/incidents.js";
import type { Event } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";

/**
 * Cards that change after they were sent, edited where the reader already saw them.
 *
 * The wire carries the start of a major outage and nothing after it, because a second message for
 * the end is a second interruption for news the reader discovers by using the service. Discord edits
 * notify nobody, so the card that said "it is broken" can say "it is fixed" at no cost to anyone's
 * attention. OpenAI's `01M2KQNE5C42NEZPX6V01NHH5W` on 2026-09-15 is the shape: started, identified,
 * monitoring and resolved inside an hour, and a reader who saw the start never learned the rest.
 */
const LOOKBACK_MS = 3 * 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const RESOLVED_COLOUR = 0x2ecc71;

/** Queues an edit for every single-card Discord message that announced an incident which has now ended. */
export function queueIncidentAmendments(db: Database, now = Date.now()): number {
  const endings = db
    .query<Event, [string]>(
      `SELECT e.* FROM events e WHERE e.stream='incidents' AND e.kind IN ('changed','removed') AND e.detected_at>=?
         AND NOT EXISTS (SELECT 1 FROM card_amendments a WHERE a.event_id=e.id)`,
    )
    .all(new Date(now - LOOKBACK_MS).toISOString())
    .filter(incidentEnded);
  let queued = 0;
  for (const ending of endings) {
    // Only a message carrying this one event: editing a digest would rewrite cards about other things.
    const cards = db
      .query<{ id: number }, [string, string]>(
        `SELECT d.id FROM deliveries d
         JOIN delivery_events de ON de.delivery_id=d.id JOIN events start ON start.id=de.event_id
         WHERE start.source=? AND start.entity_id=? AND start.kind='new' AND d.status='sent'
           AND d.external_id IS NOT NULL AND json_extract(d.destination_json,'$.platform')='discord'
           AND (SELECT COUNT(*) FROM delivery_events other WHERE other.delivery_id=d.id)=1`,
      )
      .all(ending.source, ending.entity_id);
    for (const card of cards)
      queued += db
        .query("INSERT OR IGNORE INTO card_amendments(event_id,delivery_id,updated_at) VALUES(?,?,?)")
        .run(ending.id, card.id, new Date(now).toISOString()).changes;
  }
  return queued;
}

/** The card as it was sent, marked resolved. Nothing else on it changes, and nothing it says pings. */
function resolvedCard(body: string, endedAt: string): Record<string, unknown> | null {
  const payload = JSON.parse(body) as { content?: string; embeds?: Record<string, unknown>[] };
  const embed = payload.embeds?.[0];
  if (!embed || payload.embeds?.length !== 1) return null;
  const title = String(embed.title ?? "").replace(/^\S+\s/, "");
  const unix = Math.floor(Date.parse(endedAt) / 1000);
  return {
    content: payload.content ?? "",
    embeds: [
      {
        ...embed,
        title: `✅ Resolved · ${title}`.slice(0, 250),
        color: RESOLVED_COLOUR,
        description: `${String(embed.description ?? "")}\nResolved <t:${unix}:R>`.slice(0, 4096),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export async function applyCardAmendments(db: Database, config: AppConfig, request: Fetch = fetch): Promise<void> {
  if (!config.DISCORD_BOT_TOKEN) return;
  const pending = db
    .query<
      {
        event_id: number;
        delivery_id: number;
        attempts: number;
        body: string;
        external_id: string;
        channel: string;
        ended_at: string;
      },
      [number]
    >(
      `SELECT a.event_id,a.delivery_id,a.attempts,d.body,d.external_id,
         json_extract(d.destination_json,'$.channelId') AS channel,e.detected_at AS ended_at
       FROM card_amendments a JOIN deliveries d ON d.id=a.delivery_id JOIN events e ON e.id=a.event_id
       WHERE a.status='pending' AND a.attempts<? ORDER BY a.event_id LIMIT 5`,
    )
    .all(MAX_ATTEMPTS);
  for (const amendment of pending) {
    const card = resolvedCard(amendment.body, amendment.ended_at);
    let status: "pending" | "edited" | "failed" = "failed";
    if (card) {
      try {
        const response = await request(
          `https://discord.com/api/v10/channels/${amendment.channel}/messages/${amendment.external_id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json", Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
            body: JSON.stringify(card),
            signal: AbortSignal.timeout(20_000),
            redirect: "error",
          },
        );
        await response.body?.cancel();
        // An edit is idempotent, so a failure short of a refusal is simply tried again later.
        status = response.ok ? "edited" : response.status === 404 || response.status === 403 ? "failed" : "pending";
      } catch {
        status = "pending";
      }
    }
    db.query(
      "UPDATE card_amendments SET status=?,attempts=attempts+1,updated_at=? WHERE event_id=? AND delivery_id=?",
    ).run(status, new Date().toISOString(), amendment.event_id, amendment.delivery_id);
    log(status === "edited" ? "info" : "warn", "Card amendment settled", {
      deliveryId: amendment.delivery_id,
      status,
    });
  }
}
