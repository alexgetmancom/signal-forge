import type { Database } from "bun:sqlite";
import { z } from "zod";
import { applyCardAmendments, queueIncidentAmendments } from "./amendments.js";
import { type AppConfig, type Destination, destinationSchema } from "./config.js";
import { prepareDeliveries } from "./events/batching.js";
import { logoFiles } from "./events/render/logos.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { measure } from "./runtime/metrics.js";
import { fillSummaries } from "./summary.js";

type Job = { id: number; destination_json: string; body: string; attempts: number };

/** Retry clocks and send times are stored as instants, like everything else in this database. */
const instant = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * How many times one message may be turned away by a rate limit before it is given up on. Each
 * attempt already waits for the delay the platform asks for, so reaching this means the lane has
 * been blocked for hours; the delivery becomes a failure an operator can see in `issues` instead
 * of a job that retries silently for ever.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 8;
/** Discord's limit on the files one message carries. */
const MAX_FILES = 10;
type DeliveryStatus = "pending" | "sent" | "failed" | "ambiguous";
type PreparedDelivery = {
  destination: Destination;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Evidence too long for a card, and the logos its cards show, travel as files beside it. */
  files?: { filename: string; content: string | Uint8Array }[];
};

/** A card keeps a logo only when its message carries the file; Discord shows nothing for the rest. */
function withoutMissingLogos(embed: Record<string, unknown>, carried: Set<string>): Record<string, unknown> {
  const missing = (url: unknown) =>
    typeof url === "string" && url.startsWith("attachment://") && !carried.has(url.slice("attachment://".length));
  const { thumbnail, author, ...rest } = embed as { thumbnail?: { url?: unknown }; author?: { icon_url?: unknown } };
  const { icon_url, ...name } = author ?? {};
  return {
    ...rest,
    ...(thumbnail && !missing(thumbnail.url) ? { thumbnail } : {}),
    ...(author ? { author: missing(icon_url) ? name : author } : {}),
  };
}

const telegramResponse = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int() }) });
const telegramErrorResponse = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string().optional(),
});
const discordResponse = z.object({ id: z.string().regex(/^\d+$/) });
const rateLimit = z.object({
  retry_after: z.number().nonnegative().optional(),
  parameters: z.object({ retry_after: z.number().nonnegative() }).optional(),
});

/** Discord takes a message and its files as one multipart request with the payload as a field. */
function multipart(prepared: PreparedDelivery): FormData {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(prepared.body));
  (prepared.files ?? []).forEach((file, index) => {
    const type = typeof file.content === "string" ? "text/plain" : "image/png";
    form.append(`files[${index}]`, new Blob([file.content], { type }), file.filename);
  });
  return form;
}

export function recoverInterruptedDeliveries(db: Database): void {
  db.query(
    "UPDATE deliveries SET status='ambiguous',error='Process stopped during send; verify destination before retrying',updated_at=? WHERE status='sending'",
  ).run(instant(Date.now()));
}

export async function deliverPending(db: Database, config: AppConfig, request: Fetch = fetch): Promise<void> {
  // Summaries are written before the message is built; a failure here leaves the message unchanged.
  await fillSummaries(db, config, request);
  db.transaction(() => {
    prepareDeliveries(db, Date.now(), config.vendorRoles, config.allSignalsRole);
    queueIncidentAmendments(db);
  })();
  await applyCardAmendments(db, config, request);

  const destinationIds = db
    .query<{ destination_id: string }, [string]>(
      "SELECT destination_id FROM deliveries WHERE status='pending' AND next_attempt_at<=? GROUP BY destination_id ORDER BY MIN(id)",
    )
    .all(instant(Date.now()))
    .map((row) => row.destination_id);
  const budget = { remaining: 20 };

  await Promise.all(
    destinationIds.map(async (destinationId) => {
      // One lane per destination preserves multipart order while keeping a slow platform from
      // blocking independent destinations. The shared budget keeps a busy cycle bounded.
      while (budget.remaining > 0) {
        const now = Date.now();
        const job = db
          .query<Job, [string, string, string]>(`UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=?
          WHERE id=(SELECT d.id FROM deliveries d WHERE d.destination_id=? AND d.status='pending' AND d.next_attempt_at<=?
            AND NOT EXISTS(SELECT 1 FROM deliveries earlier WHERE earlier.batch_id=d.batch_id AND earlier.destination_id=d.destination_id AND earlier.part<d.part AND earlier.status<>'sent')
            ORDER BY d.id LIMIT 1) AND status='pending' RETURNING id,destination_json,body,attempts`)
          .get(instant(now), destinationId, instant(now));
        if (!job) return;
        budget.remaining -= 1;

        let status: DeliveryStatus = "failed";
        let error: string | null = null;
        let externalId: string | null = null;
        let retryAt = 0;
        let prepared: PreparedDelivery | null = null;

        // Everything before the request is a known local failure. It cannot be ambiguous because
        // the provider has not received a request yet.
        try {
          const destination = destinationSchema.parse(JSON.parse(job.destination_json));
          if (destination.platform === "telegram") {
            if (!config.TELEGRAM_BOT_TOKEN) throw new Error("missing Telegram token");
            prepared = {
              destination,
              url: `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
              headers: { "content-type": "application/json" },
              body: {
                chat_id: destination.chatId,
                message_thread_id: destination.topicId,
                text: job.body,
                link_preview_options: { is_disabled: true },
              },
            };
          } else {
            if (!config.DISCORD_BOT_TOKEN) throw new Error("missing Discord token");
            const parsed = job.body.startsWith("{")
              ? (JSON.parse(job.body) as Record<string, unknown>)
              : { content: job.body };
            const { files: evidence = [], ...payload } = parsed as Record<string, unknown> & {
              files?: { filename: string; content: string }[];
            };
            // Evidence first: a logo is decoration, and one that does not fit is taken off the card.
            const logos = logoFiles(payload).slice(0, Math.max(0, MAX_FILES - evidence.length));
            const carried = new Set(logos.map((logo) => logo.filename));
            if (Array.isArray(payload.embeds))
              payload.embeds = (payload.embeds as Record<string, unknown>[]).map((embed) =>
                withoutMissingLogos(embed, carried),
              );
            const files = [...evidence, ...logos];
            // SUPPRESS_EMBEDS (4) hides every embed on the message, our own included — setting it on a
            // message built out of embeds delivers a bare header and nothing else.
            const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
            prepared = {
              destination,
              url: `https://discord.com/api/v10/channels/${destination.channelId}/messages`,
              // A multipart request carries its own boundary, so the content type is left to fetch.
              headers: {
                ...(files?.length ? {} : { "content-type": "application/json" }),
                Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
              },
              body: {
                allowed_mentions: { parse: [] },
                ...payload,
                ...(hasEmbeds ? {} : { flags: 4 }),
                nonce: `sf-${job.id}`,
                enforce_nonce: true,
              },
              ...(files?.length ? { files } : {}),
            };
          }
        } catch {
          error = "Delivery rejected before external request: invalid destination or missing credentials";
        }

        if (prepared) {
          try {
            const payload = prepared.files?.length ? multipart(prepared) : JSON.stringify(prepared.body);
            const response = await measure(db, `delivery.send:${prepared.destination.platform}`, () =>
              request(prepared.url, {
                method: "POST",
                headers: prepared.headers,
                body: payload,
                signal: AbortSignal.timeout(20_000),
                redirect: "error",
              }),
            );
            if (response.status === 429) {
              const retry = rateLimit.safeParse(await response.json().catch(() => null));
              const delay = retry.success ? (retry.data.parameters?.retry_after ?? retry.data.retry_after ?? 60) : 60;
              if (job.attempts >= MAX_RATE_LIMIT_ATTEMPTS) {
                // A message that has been turned away this many times is not going to be accepted
                // by waiting longer, and a job that retries for ever is a job nobody is told about.
                status = "failed";
                error = `Rate limited on ${job.attempts} attempts; the message was never accepted`;
              } else {
                status = "pending";
                retryAt = Date.now() + Math.ceil(Math.max(1, delay) * 1000);
                error = "Rate limited";
              }
              // Stop only this destination lane; another platform can continue.
            } else if (response.ok) {
              const data: unknown = await response.json();
              if (prepared.destination.platform === "telegram") {
                const success = telegramResponse.safeParse(data);
                if (success.success) {
                  externalId = String(success.data.result.message_id);
                  status = "sent";
                } else if (telegramErrorResponse.safeParse(data).success) {
                  status = "failed";
                  error = "Telegram rejected delivery";
                } else {
                  throw new Error("Invalid Telegram response");
                }
              } else {
                externalId = discordResponse.parse(data).id;
                status = "sent";
              }
            } else {
              await response.body?.cancel();
              status = response.status >= 500 ? "ambiguous" : "failed";
              error = `Platform returned HTTP ${response.status}`;
            }
          } catch {
            // The request or response may have crossed the provider boundary. Persist only a fixed,
            // safe diagnostic and require verification before any retry.
            status = "ambiguous";
            error = "Send outcome unknown: network failure or invalid provider response";
          }
        }

        db.query(
          "UPDATE deliveries SET status=?,external_id=?,error=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(status, externalId, error, instant(retryAt), instant(Date.now()), job.id);
        log(status === "sent" ? "info" : "warn", "Delivery settled", { deliveryId: job.id, status });
        if (status === "failed" || status === "ambiguous") {
          db.query(
            "UPDATE deliveries SET status='failed',error='Earlier message part was not confirmed',updated_at=? WHERE batch_id=(SELECT batch_id FROM deliveries WHERE id=?) AND destination_id=(SELECT destination_id FROM deliveries WHERE id=?) AND part>(SELECT part FROM deliveries WHERE id=?) AND status='pending'",
          ).run(instant(Date.now()), job.id, job.id, job.id);
        }
        if (status === "pending") {
          return;
        }
      }
    }),
  );
}
