import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type AppConfig, destinationSchema } from "./config.js";
import { prepareDeliveries } from "./events.js";
import { log } from "./logger.js";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Job = { id: number; destination_json: string; body: string; attempts: number };
const telegramResponse = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int() }) });
const discordResponse = z.object({ id: z.string().regex(/^\d+$/) });
const rateLimit = z.object({
  retry_after: z.number().nonnegative().optional(),
  parameters: z.object({ retry_after: z.number().nonnegative() }).optional(),
});

export function recoverInterruptedDeliveries(db: Database): void {
  db.query(
    "UPDATE deliveries SET status='ambiguous',error='Process stopped during send; verify destination before retrying',updated_at=? WHERE status='sending'",
  ).run(Date.now());
}
export async function deliverPending(db: Database, config: AppConfig, request: Fetch = fetch): Promise<void> {
  prepareDeliveries(db, Date.now(), config.REPORT_BASE_URL);
  // One sequential sender respects channel order; each claim is conditional even if another process races it.
  for (let n = 0; n < 20; n++) {
    const now = Date.now();
    const job = db
      .query<Job, [number, number]>(`UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=?
      WHERE id=(SELECT d.id FROM deliveries d WHERE d.status='pending' AND d.next_attempt<=?
        AND NOT EXISTS(SELECT 1 FROM deliveries earlier WHERE earlier.destination_id=d.destination_id AND earlier.id<d.id AND earlier.status IN ('pending','sending'))
        ORDER BY d.id LIMIT 1) AND status='pending' RETURNING id,destination_json,body,attempts`)
      .get(now, now);
    if (!job) return;
    let status = "ambiguous",
      error: string | null = null,
      externalId: string | null = null,
      retryAt = 0;
    try {
      const destination = destinationSchema.parse(JSON.parse(job.destination_json));
      let url: string, headers: Record<string, string>, body: unknown;
      if (destination.platform === "telegram") {
        if (!config.TELEGRAM_BOT_TOKEN) throw new Error("Missing Telegram token");
        url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
        headers = { "content-type": "application/json" };
        body = {
          chat_id: destination.chatId,
          message_thread_id: destination.topicId,
          text: job.body,
          link_preview_options: { is_disabled: true },
        };
      } else {
        if (!config.DISCORD_BOT_TOKEN) throw new Error("Missing Discord token");
        url = `https://discord.com/api/v10/channels/${destination.channelId}/messages`;
        headers = { "content-type": "application/json", Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` };
        body = {
          content: job.body,
          allowed_mentions: { parse: [] },
          // SUPPRESS_EMBEDS. The unfurl is Discord's own render of whatever OG image the linked
          // site ships: uncontrollable, and on a phone it buries the event under a banner.
          flags: 4,
          nonce: `sf-${job.id}`,
          enforce_nonce: true,
        };
      }
      const response = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
      if (response.status === 429) {
        const retry = rateLimit.safeParse(await response.json());
        const delay = retry.success ? (retry.data.parameters?.retry_after ?? retry.data.retry_after ?? 60) : 60;
        status = "pending";
        retryAt = Date.now() + Math.ceil(Math.max(1, delay) * 1000);
        error = "Rate limited";
        // Stop this cycle as the limit may be global to the bot.
      } else if (response.ok) {
        const data: unknown = await response.json();
        externalId =
          destination.platform === "telegram"
            ? String(telegramResponse.parse(data).result.message_id)
            : discordResponse.parse(data).id;
        status = "sent";
      } else {
        status = response.status >= 500 ? "ambiguous" : "failed";
        error = `Platform returned HTTP ${response.status}`;
      }
    } catch {
      // Exceptions can contain token-bearing Telegram URLs. Persist only a fixed, safe diagnostic.
      error = "Send outcome unknown: network failure, invalid response or missing credentials";
    }
    db.query(
      "UPDATE deliveries SET status=?,external_id=?,error=?,next_attempt=?,updated_at=? WHERE id=? AND status='sending'",
    ).run(status, externalId, error, retryAt, Date.now(), job.id);
    log(status === "sent" ? "info" : "warn", "Delivery settled", { deliveryId: job.id, status });
    if (status === "failed" || status === "ambiguous") {
      db.query(
        "UPDATE deliveries SET status='failed',error='Earlier message part was not confirmed',updated_at=? WHERE batch_id=(SELECT batch_id FROM deliveries WHERE id=?) AND destination_id=(SELECT destination_id FROM deliveries WHERE id=?) AND id>? AND status='pending'",
      ).run(Date.now(), job.id, job.id, job.id);
    }
    if (status === "pending") {
      db.query("UPDATE deliveries SET next_attempt=MAX(next_attempt,?) WHERE status='pending'").run(retryAt);
      return;
    }
  }
}
