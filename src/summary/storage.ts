import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { type DeepSeekAttemptResult, finishDeepSeekUsage, safeErrorType } from "../runtime/deepseekLedger.js";
import { writeTransaction } from "../storage/transaction.js";

/**
 * The attempt and the sentence it produced, written together or not at all.
 *
 * These used to be two statements: the usage row was completed, then the summary was inserted. A
 * crash in between leaves an attempt marked `summarized` with nothing behind it, and the pending
 * query excludes every event whose usage has settled -- so that event is never summarised again,
 * and its card ships the empty version of itself. One transaction closes the window.
 *
 * A storage failure settles the attempt as `failed` rather than rolling it back to `pending`,
 * because `pending` counts as settled everywhere it is read and would strand the event just as
 * permanently. `failed` is the one outcome that is allowed to be tried again.
 */
export function settleSummary(
  db: Database,
  usageId: number,
  result: DeepSeekAttemptResult,
  sentence: { eventIds: readonly number[]; text: string; at: string } | null,
): number {
  try {
    return writeTransaction(db, () => {
      finishDeepSeekUsage(db, usageId, result);
      if (!sentence) return 0;
      for (const eventId of sentence.eventIds)
        db.query("INSERT OR REPLACE INTO summaries(event_id,text,created_at) VALUES(?,?,?)").run(
          eventId,
          sentence.text,
          sentence.at,
        );
      return sentence.eventIds.length;
    });
  } catch (error) {
    log("warn", "Summary could not be stored", { errorType: safeErrorType(error) });
    finishDeepSeekUsage(db, usageId, {
      outcome: "failed",
      responseStatus: result.responseStatus,
      usage: result.usage,
      errorType: safeErrorType(error),
    });
    return 0;
  }
}
