import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import type { Event } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import {
  claimDeepSeekUsage,
  DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT,
  DEEPSEEK_SUMMARY_MAX_INPUT_CHARS,
  type DeepSeekAttemptResult,
  deepSeekAttemptsToday,
} from "../runtime/deepseekLedger.js";
import { eventTitle } from "./events.js";
import { failedResult, promptContent, type SummaryContext, type SummaryResult, summarize } from "./model.js";
import { settleSummary } from "./storage.js";

/** A documentation rollout is one thing that happened, however many pages it rewrote. */
const ROLLOUT_PAGES = 3;

/**
 * The page diffs a single source published in one read, grouped by source, where there are enough
 * of them to be a rollout rather than an edit.
 *
 * On 2026-09-22 Codex renamed its default model and twenty-one documentation pages changed at once.
 * Summarised one page at a time that is twenty-one calls for twenty-one sentences saying the same
 * thing, and the card carries whichever page happened to lead. Summarised together it is one call,
 * and the sentence a reader gets is about the rollout.
 */
export function rolloutGroups<T extends Event>(pending: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const event of pending) {
    if (event.kind !== "changed" || !["pages", "web"].includes(event.stream)) continue;
    groups.set(event.source, [...(groups.get(event.source) ?? []), event]);
  }
  for (const [source, events] of groups) if (events.length < ROLLOUT_PAGES) groups.delete(source);
  return groups;
}

export async function summarizeRollouts(
  db: Database,
  config: AppConfig,
  pending: readonly (Event & { url: string })[],
  request: Fetch,
  now: Date,
): Promise<{ claimed: number; written: number; inRollout: Set<number> }> {
  let claimedRollout = 0;
  let written = 0;
  // A rollout is summarised once, before the per-event loop, and every page of it carries that
  // sentence: whichever page ends up leading the card, the card describes the whole rollout.
  const rollouts = rolloutGroups(pending);
  const inRollout = new Set<number>();
  for (const [source, events] of rollouts) {
    for (const event of events) inRollout.add(event.id);
    if (deepSeekAttemptsToday(db, now) >= DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT) continue;
    const lead = events[0];
    if (!lead) continue;
    const body = events
      .map((event) =>
        [
          `PAGE: ${eventTitle(event)}`,
          event.before_json ? `PREVIOUS:\n${event.before_json}` : "",
          `CURRENT:\n${event.after_json ?? ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")
      .slice(0, DEEPSEEK_SUMMARY_MAX_INPUT_CHARS);
    const context = {
      source,
      stream: lead.stream,
      kind: lead.kind,
      title: `${events.length} pages changed at ${source}`,
      shape: "at most three short factual sentences, 55 words in all",
      maxWords: 55,
      guidance:
        "These are pages that changed together in one publication. Name the facts a reader would act on -- a new model, a price, a date, a default, a retirement -- and skip pages that only swapped one model name for another. If nothing but names changed, say so in one sentence.",
    } satisfies SummaryContext;
    const usageId = claimDeepSeekUsage(db, {
      eventId: lead.id,
      source,
      stream: lead.stream,
      inputChars: promptContent(body, context).length,
      attemptedAt: now,
    });
    if (usageId === null) continue;
    claimedRollout++;
    let summary: SummaryResult;
    try {
      summary = await summarize(body, config, request, context);
    } catch (error) {
      summary = failedResult(promptContent(body, context).length, error);
    }
    const recordedRollout: DeepSeekAttemptResult =
      summary.outcome === "disabled"
        ? { outcome: "failed", responseStatus: null, usage: null, errorType: "Disabled" }
        : {
            outcome: summary.outcome,
            responseStatus: summary.responseStatus,
            usage: summary.usage,
            errorType: summary.errorType,
          };
    written += settleSummary(
      db,
      usageId,
      recordedRollout,
      summary.text ? { eventIds: events.map((event) => event.id), text: summary.text, at: now.toISOString() } : null,
    );
  }
  return { claimed: claimedRollout, written, inRollout };
}
