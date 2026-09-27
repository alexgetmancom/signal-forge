import type { Database } from "bun:sqlite";
import { log } from "../logger.js";
import { calculateDeepSeekCost, type DeepSeekTokenUsage, pricingPeriod } from "./deepseekPricing.js";

export const DEEPSEEK_SUMMARY_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_SUMMARY_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_SUMMARY_OPERATION = "summary.fillSummaries";
export const DEEPSEEK_SUMMARY_MAX_INPUT_CHARS = 6_000;
// A sentence the model cannot finish is discarded, so the ceiling decides how many summaries
// survive rather than how long they are. Ten calls cost $0.0016 on 2026-09-14, and the daily
// attempt limit caps the whole integration well under a dollar a day at this width.
export const DEEPSEEK_SUMMARY_MAX_OUTPUT_TOKENS = 160;
export const DEEPSEEK_SUMMARY_DAILY_ATTEMPT_LIMIT = 300;
export type DeepSeekOutcome = "pending" | "summarized" | "unclear" | "invalid" | "rejected" | "failed" | "legacy";

export type DeepSeekAttemptResult = {
  outcome: Exclude<DeepSeekOutcome, "pending" | "legacy">;
  responseStatus: number | null;
  usage: DeepSeekTokenUsage | null;
  errorType: string | null;
};

type DeepSeekUsageContext = {
  eventId: number;
  source: string;
  stream: string;
  inputChars: number;
  attemptedAt: Date;
};

export function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim().replace(/\s+/g, " ").slice(0, 120);
  return "UnknownError";
}

/** Attempts one event may ever cost, ceiling included in the schema as a CHECK. */
export const DEEPSEEK_MAX_ATTEMPTS = 2;

/**
 * True while this event may still be attempted: no settled answer, and the ceiling not yet spent.
 *
 * 'unclear' and 'failed' are the outcomes worth asking again about -- the model was reached and said
 * nothing usable, or it was not reached at all. A summarised, rejected or invalid answer is an
 * answer, and asking twice would only pay twice for it. A claim left 'pending' by a crash counts as
 * settled, as it did when one claim per event was the whole rule.
 */
function deepSeekAttemptsLeft(db: Database, eventId: number): boolean {
  const row = db
    .query<{ spent: number; settled: number }, [number]>(
      `SELECT COUNT(*) spent,
              SUM(CASE WHEN outcome IN ('unclear','failed') THEN 0 ELSE 1 END) settled
         FROM deepseek_usage WHERE event_id=?`,
    )
    .get(eventId);
  return (row?.settled ?? 0) === 0 && (row?.spent ?? 0) < DEEPSEEK_MAX_ATTEMPTS;
}

/** Claims one event before the network request, so concurrent workers cannot pay twice for it. */
export function claimDeepSeekUsage(db: Database, context: DeepSeekUsageContext): number | null {
  try {
    if (!deepSeekAttemptsLeft(db, context.eventId)) return null;
    const spent = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM deepseek_usage WHERE event_id=?")
      .get(context.eventId);
    const row = db
      .query<
        { id: number },
        [number, string, string, string, string, string, number, number, number, string, string, string]
      >(
        `INSERT INTO deepseek_usage(
           event_id,attempted_at,operation,source,stream,model,attempts,attempt,input_chars,outcome,cost_basis,pricing_period
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        context.eventId,
        context.attemptedAt.toISOString(),
        DEEPSEEK_SUMMARY_OPERATION,
        context.source,
        context.stream,
        DEEPSEEK_SUMMARY_MODEL,
        1,
        (spent?.n ?? 0) + 1,
        Math.max(0, Math.round(context.inputChars)),
        "pending",
        "unknown",
        pricingPeriod(context.attemptedAt),
      );
    return row?.id ?? null;
  } catch (error) {
    log("warn", "DeepSeek usage claim could not be stored", {
      event: context.eventId,
      errorType: safeErrorType(error),
    });
    return null;
  }
}

/** Completes the claim with provider usage and a frozen price calculation. */
export function finishDeepSeekUsage(db: Database, id: number, result: DeepSeekAttemptResult): void {
  try {
    const row = db
      .query<{ attempted_at: string }, [number]>("SELECT attempted_at FROM deepseek_usage WHERE id=?")
      .get(id);
    if (!row) return;
    const cost = calculateDeepSeekCost(result.usage, row.attempted_at);
    db.query(
      `UPDATE deepseek_usage
       SET response_status=?,outcome=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,
           prompt_cache_hit_tokens=?,prompt_cache_miss_tokens=?,cost_usd=?,cost_basis=?,pricing_period=?,error_type=?
       WHERE id=?`,
    ).run(
      result.responseStatus,
      result.outcome,
      result.usage?.promptTokens ?? null,
      result.usage?.completionTokens ?? null,
      result.usage?.totalTokens ?? null,
      result.usage?.promptCacheHitTokens ?? null,
      result.usage?.promptCacheMissTokens ?? null,
      cost.costUsd,
      cost.costBasis,
      cost.pricingPeriod,
      result.errorType,
      id,
    );
  } catch (error) {
    log("warn", "DeepSeek usage result could not be stored", { usageId: id, errorType: safeErrorType(error) });
  }
}

export function deepSeekAttemptsToday(db: Database, now: Date): number {
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
  const end = new Date(Date.parse(start) + 24 * 3_600_000).toISOString();
  const row = db
    .query<{ attempts: number | null }, [string, string]>(
      "SELECT COALESCE(SUM(attempts),0) AS attempts FROM deepseek_usage WHERE attempted_at>=? AND attempted_at<?",
    )
    .get(start, end);
  return Math.max(0, Number(row?.attempts ?? 0));
}

type JudgeAttempt = { outcome: string; attempted_at: string; cost_usd: number | null; error_type: string | null };

/** The unbroken run of unusable answers at the head of one judge's ledger, newest first. */
export function judgeRun(db: Database, operation: string, source: string, window: number): JudgeAttempt[] {
  const rows = db
    .query<JudgeAttempt, [string, string, number]>(
      `SELECT outcome,attempted_at,cost_usd,error_type FROM deepseek_usage
        WHERE event_id IS NULL AND operation=? AND source=? ORDER BY attempted_at DESC, id DESC LIMIT ?`,
    )
    .all(operation, source, Math.max(1, Math.trunc(window)));
  const run: JudgeAttempt[] = [];
  for (const row of rows) {
    if (row.outcome === "summarized") break;
    run.push(row);
  }
  return run;
}

/**
 * The run of unusable answers a judge has just had on one source, newest first, and how long ago
 * the last of them was.
 *
 * A judge has no per-entry bookkeeping the way a summary has `event_id`: what it was asked about is
 * not in the ledger, only that it was asked. So the ceiling is read off the answers instead -- the
 * summary path already holds that an invalid answer is an answer and asking twice only pays twice
 * (see `deepSeekAttemptable`), and this is the same rule for a caller that re-asks from a backlog.
 * Anything but `summarized` is unusable; one usable answer ends the run.
 */
export function unusableJudgeRun(
  db: Database,
  operation: string,
  source: string,
  now: Date,
  window = 16,
): { attempts: number; msSinceLast: number } {
  const run = judgeRun(db, operation, source, window);
  const last = run[0]?.attempted_at;
  return {
    attempts: run.length,
    msSinceLast: last ? Math.max(0, now.getTime() - Date.parse(last)) : Number.POSITIVE_INFINITY,
  };
}

/**
 * Records one call that answers no event -- a judge, not a summary -- already settled, so its cost
 * is in the same ledger. The schema's outcomes are a summary's; an answer is stored as
 * `summarized`, and the operation tells the two apart.
 */
export function recordDeepSeekCall(
  db: Database,
  context: { operation: string; source: string; stream: string; inputChars: number; attemptedAt: Date },
  result: DeepSeekAttemptResult,
): void {
  try {
    const cost = calculateDeepSeekCost(result.usage, context.attemptedAt);
    db.query(
      `INSERT INTO deepseek_usage(
         event_id,attempted_at,operation,source,stream,model,attempts,attempt,input_chars,response_status,outcome,
         prompt_tokens,completion_tokens,total_tokens,prompt_cache_hit_tokens,prompt_cache_miss_tokens,
         cost_usd,cost_basis,pricing_period,error_type
       ) VALUES(NULL,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      context.attemptedAt.toISOString(),
      context.operation,
      context.source,
      context.stream,
      DEEPSEEK_SUMMARY_MODEL,
      Math.max(0, Math.round(context.inputChars)),
      result.responseStatus,
      result.outcome,
      result.usage?.promptTokens ?? null,
      result.usage?.completionTokens ?? null,
      result.usage?.totalTokens ?? null,
      result.usage?.promptCacheHitTokens ?? null,
      result.usage?.promptCacheMissTokens ?? null,
      cost.costUsd,
      cost.costBasis,
      cost.pricingPeriod,
      result.errorType,
    );
  } catch (error) {
    log("warn", "DeepSeek call could not be recorded", {
      operation: context.operation,
      errorType: safeErrorType(error),
    });
  }
}
