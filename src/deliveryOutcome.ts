/**
 * 17 declarations moved out of delivery.ts unchanged.
 *
 * Say here what they have in common, because that is the only reason this file exists.
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Job, PreparedDelivery } from "./deliveryRequest.js";

type DeliveryStatus = "pending" | "sent" | "failed" | "ambiguous";
/**
 * What one platform's answer amounted to, before the row is written.
 *
 * Every field is decided together: a rate limit is `pending` with a clock, a 5xx is `ambiguous`
 * with no clock, and a refusal is `pending` with a clock and a `Blocked:` prefix the caller reads
 * to refund the attempt. Returning them one at a time is how a status once travelled without the
 * retry time that made sense of it.
 */
export type Settlement = { status: DeliveryStatus; error: string | null; externalId: string | null; retryAt: number };

/**
 * How many times one message may be turned away by a rate limit before it is given up on. Each
 * attempt already waits for the delay the platform asks for, so reaching this means the lane has
 * been blocked for hours; the delivery becomes a failure an operator can see in `issues` instead
 * of a job that retries silently for ever.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 8;

/**
 * A destination that refuses the bot -- a channel made read-only, a role removed, the bot taken out
 * of a chat -- is a door somebody can open again, not a message that can never be delivered. On
 * 2026-09-19 both reader channels denied Send Messages to @everyone for ten hours and four cards
 * were dropped for good, although the fix was one permission. A refused message now waits and asks
 * again, in order, until the door opens; only news older than this is let go.
 */
const BLOCKED_RETRY_MS = 10 * 60_000;
const BLOCKED_GIVE_UP_MS = 3 * 24 * 3_600_000;
export const BLOCKED_PREFIX = "Blocked:";

/** The refusals an owner fixes in the destination rather than in the message. */
function refusedAccess(platform: string, status: number, code: number | null): boolean {
  if (status === 401 || status === 403) return true;
  // Discord 10003 is Unknown Channel: a channel deleted or re-created under a new id in the config.
  return platform === "discord" && status === 404 && code === 10003;
}

const platformError = z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough();
const telegramDescription = z.object({ error_code: z.number().optional(), description: z.string().optional() });
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

/** Wait as long as the platform asked, until the message has been turned away too often to be news. */
async function rateLimited(job: Job, response: Response): Promise<Settlement> {
  const retry = rateLimit.safeParse(await response.json().catch(() => null));
  const delay = retry.success ? (retry.data.parameters?.retry_after ?? retry.data.retry_after ?? 60) : 60;
  if (job.attempts >= MAX_RATE_LIMIT_ATTEMPTS)
    // A message that has been turned away this many times is not going to be accepted by waiting
    // longer, and a job that retries for ever is a job nobody is told about.
    return {
      status: "failed",
      error: `Rate limited on ${job.attempts} attempts; the message was never accepted`,
      externalId: null,
      retryAt: 0,
    };
  return {
    status: "pending",
    error: "Rate limited",
    externalId: null,
    retryAt: Date.now() + Math.ceil(Math.max(1, delay) * 1000),
  };
}

/**
 * A 2xx is not yet a delivery: both platforms answer 200 to things they did not post.
 *
 * A body neither schema recognises throws, so the caller records it as ambiguous and a human
 * verifies the destination before anything is sent twice.
 */
async function accepted(prepared: PreparedDelivery, response: Response): Promise<Settlement> {
  const data: unknown = await response.json();
  if (prepared.destination.platform !== "telegram")
    return { status: "sent", error: null, externalId: discordResponse.parse(data).id, retryAt: 0 };
  const success = telegramResponse.safeParse(data);
  if (success.success)
    return { status: "sent", error: null, externalId: String(success.data.result.message_id), retryAt: 0 };
  if (telegramErrorResponse.safeParse(data).success)
    return { status: "failed", error: "Telegram rejected delivery", externalId: null, retryAt: 0 };
  throw new Error("Invalid Telegram response");
}

/**
 * A refusal in the platform's own words, and whether it is a door or a dead message.
 *
 * "50013 Missing Permissions" sends the owner to the channel settings, where a bare status sends
 * them to the database. The words are the platform's own and are clipped to a line; nothing of the
 * response body beyond that is kept.
 */
async function rejected(db: Database, job: Job, prepared: PreparedDelivery, response: Response): Promise<Settlement> {
  const answer: unknown = await response.json().catch(() => null);
  const discord = platformError.safeParse(answer);
  const telegram = telegramDescription.safeParse(answer);
  const code = discord.success ? (discord.data.code ?? null) : null;
  const reason =
    discord.success && discord.data.message
      ? `${code ?? ""} ${discord.data.message}`.trim()
      : telegram.success && telegram.data.description
        ? telegram.data.description
        : "";
  const said = `Platform returned HTTP ${response.status}${reason ? `: ${reason.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
  if (!refusedAccess(prepared.destination.platform, response.status, code))
    return {
      status: response.status >= 500 ? "ambiguous" : "failed",
      error: said,
      externalId: null,
      retryAt: 0,
    };
  const readyAt = db
    .query<{ ready_at: string }, [number]>(
      "SELECT b.ready_at FROM deliveries d JOIN batches b ON b.id=d.batch_id WHERE d.id=?",
    )
    .get(job.id)?.ready_at;
  const age = Date.now() - Date.parse(readyAt ?? "");
  if (Number.isFinite(age) && age > BLOCKED_GIVE_UP_MS)
    return { status: "failed", error: `${said}; refused for three days, no longer news`, externalId: null, retryAt: 0 };
  return {
    status: "pending",
    error: `${BLOCKED_PREFIX} ${said}`,
    externalId: null,
    retryAt: Date.now() + BLOCKED_RETRY_MS,
  };
}

/**
 * What the platform's answer amounts to. Reads the response and one row, and sends nothing.
 *
 * A throw from here is the caller's ambiguous case: the request did cross the provider boundary,
 * so an answer that cannot be read is not the same as a message that was not posted.
 */
export async function settle(
  db: Database,
  job: Job,
  prepared: PreparedDelivery,
  response: Response,
): Promise<Settlement> {
  // Stop only this destination lane on a rate limit; another platform can continue.
  if (response.status === 429) return await rateLimited(job, response);
  return response.ok ? await accepted(prepared, response) : await rejected(db, job, prepared, response);
}
