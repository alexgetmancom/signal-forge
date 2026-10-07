import type { Database } from "bun:sqlite";
import { applyCardAmendments, queueIncidentAmendments, queuePriceAmendments } from "./amendments.js";
import { type AppConfig, type Destination, judged } from "./config.js";
import { BLOCKED_PREFIX, type Settlement, settle } from "./deliveryOutcome.js";
import { type Job, multipart, PreparationError, type PreparedDelivery, prepareRequest } from "./deliveryRequest.js";
import { prepareDeliveries } from "./events/batching.js";
import { releaseSettledMoves } from "./events/cooldown.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { measure } from "./runtime/metricRecording.js";
import { writeTransaction } from "./storage/transaction.js";
import { fillSummaries } from "./summary.js";

/** What a delivery says when it never reached the provider; the reason follows. */
const REJECTED_BEFORE_REQUEST = "Delivery rejected before external request";

/** Retry clocks and send times are stored as instants, like everything else in this database. */
const instant = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * The first 👍 under a Telegram post, as Discord gets one under every card in a room with readers:
 * an empty row asks nobody anything, and one already there says "tap if this was useful". A bot has
 * a single reaction per message, so there is no 👎 beside it, and a Telegram channel's thumbs are
 * therefore favour with no refusal to weigh against -- which is why `tg-news` reads as 26 in favour
 * and none against. Decoration: a refusal never touches the delivery.
 *
 * `judged` asks the same question Discord's seeding asks, in the same words: a channel the owner
 * keeps for himself is not a room to invite a vote in. No Telegram destination says `none` today;
 * the rule lives here anyway, because the first one that does should not have to discover that the
 * two transports read the same field differently.
 */
async function seedReaction(destination: Destination, messageId: number, config: AppConfig, request: Fetch) {
  if (destination.platform !== "telegram" || !judged(destination)) return;
  try {
    const response = await request(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setMessageReaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: destination.chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: "👍" }],
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) log("warn", "Telegram reaction not set", { status: response.status });
  } catch (failure) {
    log("warn", "Telegram reaction not set", { error: failure instanceof Error ? failure.message : String(failure) });
  }
}

export function recoverInterruptedDeliveries(db: Database): void {
  db.query(
    "UPDATE deliveries SET status='ambiguous',error='Process stopped during send; verify destination before retrying',updated_at=? WHERE status='sending'",
  ).run(instant(Date.now()));
}

export async function deliverPending(db: Database, config: AppConfig, request: Fetch = fetch): Promise<void> {
  // Summaries are written before the message is built; a failure here leaves the message unchanged.
  await fillSummaries(db, config, request);
  writeTransaction(db, () => {
    releaseSettledMoves(db, Date.now());
    prepareDeliveries(db, Date.now(), config.vendorRoles, config.allSignalsRole);
    queueIncidentAmendments(db);
    queuePriceAmendments(db);
  });
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
            AND NOT EXISTS(SELECT 1 FROM deliveries refused WHERE refused.destination_id=d.destination_id AND refused.id<d.id AND refused.status='pending' AND refused.error LIKE 'Blocked:%')
            ORDER BY d.id LIMIT 1) AND status='pending' RETURNING id,destination_json,body,attempts`)
          .get(instant(now), destinationId, instant(now));
        if (!job) return;
        budget.remaining -= 1;

        let settlement: Settlement = {
          status: "failed",
          error: `${REJECTED_BEFORE_REQUEST}: the request could not be built`,
          externalId: null,
          retryAt: 0,
        };
        let prepared: PreparedDelivery | null = null;
        // Everything before the request is a known local failure. It cannot be ambiguous because
        // the provider has not received a request yet, which is why the default above says so.
        try {
          prepared = await prepareRequest(job, config);
        } catch (error) {
          prepared = null;
          if (error instanceof PreparationError)
            settlement = { ...settlement, error: `${REJECTED_BEFORE_REQUEST}: ${error.message}` };
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
            settlement = await settle(db, job, prepared, response);
            if (settlement.status === "sent" && settlement.externalId)
              await seedReaction(prepared.destination, Number(settlement.externalId), config, request);
          } catch {
            // The request or response may have crossed the provider boundary. Persist only a fixed,
            // safe diagnostic and require verification before any retry.
            settlement = {
              status: "ambiguous",
              error: "Send outcome unknown: network failure or invalid provider response",
              externalId: null,
              retryAt: 0,
            };
          }
        }

        const { status, error, externalId, retryAt } = settlement;
        db.query(
          "UPDATE deliveries SET status=?,external_id=?,error=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(status, externalId, error, instant(retryAt), instant(Date.now()), job.id);
        // A refusal is not an attempt at the message: it must not spend the rate-limit allowance
        // the message will need once the destination opens again.
        if (error?.startsWith(BLOCKED_PREFIX))
          db.query("UPDATE deliveries SET attempts=MAX(attempts-1,0) WHERE id=?").run(job.id);
        log(status === "sent" ? "info" : "warn", "Delivery settled", {
          deliveryId: job.id,
          status,
          ...(error ? { error } : {}),
        });
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
