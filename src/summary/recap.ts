import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import type { Event } from "../events/types.js";
import { featureEnabled } from "../features.js";
import type { Fetch } from "../http-client.js";
import {
  claimDeepSeekUsage,
  DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT,
  type DeepSeekAttemptResult,
  deepSeekAttemptsToday,
} from "../runtime/deepseekLedger.js";
import { eventTitle } from "./events.js";
import { failedResult, promptContent, type SummaryResult, summarize } from "./model.js";
import { settleSummary } from "./storage.js";

/**
 * One sentence for one event, outside the delivery path: a line in a morning recap rather than a
 * card's lead. Claimed and recorded like every other attempt, so it shares the daily ceiling and
 * shows in the usage report; stored where cards read theirs, so an event summarised here is never
 * paid for twice.
 */
export async function summarizeForRecap(
  db: Database,
  config: AppConfig,
  event: Event,
  guidance: string,
  request: Fetch = fetch,
  now = new Date(),
): Promise<string | null> {
  if (!featureEnabled(config, "deepseek-summaries")) return null;
  if (deepSeekAttemptsToday(db, now) >= DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT) return null;
  const stored = db.query<{ text: string }, [number]>("SELECT text FROM summaries WHERE event_id=?").get(event.id);
  if (stored) return stored.text;
  const body = [event.before_json ? `PREVIOUS:\n${event.before_json}` : "", `CURRENT:\n${event.after_json ?? ""}`]
    .filter(Boolean)
    .join("\n\n");
  const context = { source: event.source, stream: event.stream, kind: event.kind, title: eventTitle(event), guidance };
  const usageId = claimDeepSeekUsage(db, {
    eventId: event.id,
    source: event.source,
    stream: event.stream,
    inputChars: promptContent(body, context).length,
    attemptedAt: now,
  });
  if (usageId === null) return null;
  let summary: SummaryResult;
  try {
    summary = await summarize(body, config, request, context);
  } catch (error) {
    summary = failedResult(body.length, error);
  }
  const recordedRecap: DeepSeekAttemptResult =
    summary.outcome === "disabled"
      ? { outcome: "failed", responseStatus: null, usage: null, errorType: "Disabled" }
      : {
          outcome: summary.outcome,
          responseStatus: summary.responseStatus,
          usage: summary.usage,
          errorType: summary.errorType,
        };
  const kept = settleSummary(
    db,
    usageId,
    recordedRecap,
    summary.text ? { eventIds: [event.id], text: summary.text, at: now.toISOString() } : null,
  );
  // A sentence that could not be stored is not a sentence the caller can quote: the recap would
  // print it while nothing else could ever find it again.
  return kept ? summary.text : null;
}
