import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import type { Event } from "./events/types.js";
import { featureEnabled } from "./features.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import {
  claimDeepSeekUsage,
  DEEPSEEK_MAX_ATTEMPTS,
  DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT,
  type DeepSeekAttemptResult,
  deepSeekAttemptsToday,
} from "./runtime/deepseekLedger.js";
import { packageReleaseNotes } from "./sources/packageNotes.js";
import { eventTitle, needsSummary, summaryMaterial } from "./summary/events.js";
import { failedResult, promptContent, type SummaryContext, type SummaryResult, summarize } from "./summary/model.js";
import { summarizeRollouts } from "./summary/rollouts.js";
import { settleSummary } from "./summary/storage.js";

/**
 * A rewritten page or a large commit arrives as forty changed fields. The message can count them,
 * but counting is not reading. One sentence in front of the evidence is the difference between a
 * reader skipping the message and a reader knowing whether it matters to them.
 *
 * Three rules make this safe to run unattended:
 *
 * 1. The sentence never replaces the evidence, it precedes it. A wrong summary is then visibly
 *    wrong rather than authoritative.
 * 2. The input is untrusted — it is text scraped from vendor pages, and a page can contain
 *    instructions aimed at a model. The prompt frames it as data, the output is capped and stripped
 *    of anything that could mention or link, and nothing in it is ever executed.
 * 3. Failure is silent and the message goes out unchanged. A summariser that can break delivery is
 *    worse than no summariser.
 */

/**
 * Summarises the events waiting in unsealed batches, so the sentence exists by the time the
 * message is built. Every attempted event is claimed and recorded, including rejected or unclear
 * responses, so a provider failure cannot turn into a paid retry loop.
 */
export async function fillSummaries(
  db: Database,
  config: AppConfig,
  request: Fetch = fetch,
  now = new Date(),
): Promise<number> {
  if (!config.DEEPSEEK_API_KEY) return 0;
  const pending = db
    .query<Event & { url: string }, [string]>(
      `SELECT e.*, COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),be.url) AS url FROM batches b
       JOIN batch_events be ON be.batch_id = b.id
       JOIN events e ON e.id = be.event_id
       WHERE b.sealed = 0
         AND (b.ready_at <= ? OR b.digest = 1)
         AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.event_id=e.id)
         AND NOT EXISTS (SELECT 1 FROM deepseek_usage u WHERE u.event_id=e.id
                           AND u.outcome NOT IN ('unclear','failed'))
         AND (SELECT COUNT(*) FROM deepseek_usage u WHERE u.event_id=e.id) < ${DEEPSEEK_MAX_ATTEMPTS}
       ORDER BY e.id`,
    )
    .all(now.toISOString());
  return await summarizeEvents(db, config, pending, request, now);
}

/**
 * Summarises the events handed over, claiming and recording each attempt. Shared by the delivery
 * path, which picks the events waiting in unsealed batches, and by the backfill script, which picks
 * the ones whose batch was sealed before a sentence was written.
 */
export async function summarizeEvents(
  db: Database,
  config: AppConfig,
  pending: readonly (Event & { url: string })[],
  request: Fetch = fetch,
  now = new Date(),
): Promise<number> {
  if (!featureEnabled(config, "deepseek-summaries")) return 0;
  const {
    claimed: claimedRollout,
    written: rolloutWritten,
    inRollout,
  } = await summarizeRollouts(db, config, pending, request, now);
  let written = rolloutWritten;
  // Twenty attempts a cycle, counted where they are spent: an event that needs no sentence is
  // passed over without taking a place, so it can never keep one that does waiting behind it.
  let claimed = claimedRollout;
  for (const event of pending) {
    if (claimed >= 20) break;
    if (inRollout.has(event.id)) continue;
    if (deepSeekAttemptsToday(db, now) >= DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT) {
      log("warn", "Summary budget reached for today");
      break;
    }
    const added = await summarizeEvent(db, config, event, request, now);
    if (added === null) continue;
    claimed++;
    written += added;
  }
  return written;
}

async function summarizeEvent(
  db: Database,
  config: AppConfig,
  event: Event & { url: string },
  request: Fetch,
  now: Date,
): Promise<number | null> {
  // Release notes are enrichment; an unavailable registry leaves the version bump as it was.
  let notes: string | null = null;
  try {
    notes = await packageReleaseNotes(event, config, request);
  } catch {
    notes = null;
  }
  if (!notes && !needsSummary(event, event.url)) return null;
  // Read the observation itself because the rendered card may have shortened it.
  const body = notes ? [`CURRENT:\n${event.after_json ?? ""}`, notes].join("\n\n") : summaryMaterial(event);
  const context = {
    source: event.source,
    stream: event.stream,
    kind: event.kind,
    title: eventTitle(event),
  } satisfies SummaryContext;
  const inputChars = promptContent(body, context).length;
  const usageId = claimDeepSeekUsage(db, {
    eventId: event.id,
    source: event.source,
    stream: event.stream,
    inputChars,
    attemptedAt: now,
  });
  if (usageId === null) return null;
  let summary: SummaryResult;
  try {
    summary = await summarize(body, config, request, context);
  } catch (error) {
    summary = failedResult(inputChars, error);
  }
  const recorded: DeepSeekAttemptResult =
    summary.outcome === "disabled"
      ? { outcome: "failed", responseStatus: null, usage: null, errorType: "Disabled" }
      : {
          outcome: summary.outcome,
          responseStatus: summary.responseStatus,
          usage: summary.usage,
          errorType: summary.errorType,
        };
  if (summary.outcome === "failed")
    log("warn", "Summary failed", { event: event.id, errorType: summary.errorType ?? "UnknownError" });
  return settleSummary(
    db,
    usageId,
    recorded,
    summary.text ? { eventIds: [event.id], text: summary.text, at: now.toISOString() } : null,
  );
}
