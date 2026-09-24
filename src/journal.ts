import type { Database } from "bun:sqlite";
import { log } from "./logger.js";

/**
 * Every call an operator made, on whichever surface they made it from.
 *
 * The case this was built for is a delivery whose outcome was decided by hand: the row says `sent`,
 * and nothing else in the database says who decided that, when, or on what evidence. Asking "has
 * anyone already verified this?" before sending anything a second time needs an answer that does
 * not depend on somebody remembering. That is what `mutates` marks, and `listOperatorActions`
 * still answers only from those.
 *
 * Reads are here for a different reason. Nobody but an agent operates this repository, and an
 * agent's reads are a record of which questions the commands could not answer: 558 calls to `sql`
 * against a registry of fifty commands says the registry has gaps, and the queries say where. The
 * volume is small -- these are hand-driven calls, tens a day against twenty thousand collection
 * metrics -- and they are pruned like everything else.
 */
export type JournalSurface = "cli" | "http" | "mcp";
export type JournalOutcome = "ok" | "rejected" | "failed";

export type JournalEntry = {
  id: number;
  recordedAt: string;
  surface: JournalSurface;
  operation: string;
  input: unknown;
  outcome: JournalOutcome;
  detail: string | null;
};

/** Inputs are operator-supplied and small; a stored one that cannot be serialized is still a fact. */
/**
 * Field names whose value is never worth keeping and sometimes dangerous to.
 *
 * While only mutations were journalled this was a short, hand-checked list of inputs. Recording
 * every call means recording arguments nobody chose for the journal, on three surfaces, kept for
 * months -- and this service goes to lengths elsewhere to make sure a credential cannot reach
 * stored text: the capability report names settings and never values, and a failed collection
 * withholds its own error message because it can quote one. A telemetry table is a poor place to
 * undo that, so the same rule is applied here rather than assumed.
 */
const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|credential|cookie)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1),
    ]),
  );
}

function serializeInput(input: unknown): string {
  try {
    return JSON.stringify(redact(input) ?? {});
  } catch {
    return '"unserializable input"';
  }
}

export function recordOperatorAction(
  db: Database,
  entry: {
    surface: JournalSurface;
    operation: string;
    input: unknown;
    outcome: JournalOutcome;
    detail?: string;
    /** A read is recorded too, and marked so the mutation journal stays the answer it was. */
    mutates?: boolean;
    durationMs?: number;
  },
  now = Date.now(),
): void {
  try {
    db.query(
      `INSERT INTO operator_journal(recorded_at,surface,operation,input_json,outcome,detail,mutates,duration_ms)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      new Date(now).toISOString(),
      entry.surface,
      entry.operation,
      serializeInput(entry.input),
      entry.outcome,
      entry.detail ?? null,
      entry.mutates === false ? 0 : 1,
      entry.durationMs === undefined ? null : Math.round(entry.durationMs),
    );
  } catch (error) {
    // Telemetry must never be the reason a command fails. A mutation that ran and went unrecorded
    // is a worse outcome than a missing row, but a command that refused to run because its own
    // bookkeeping failed is worse than both.
    log("warn", "Operator action could not be journalled", {
      operation: entry.operation,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

export function listOperatorActions(
  db: Database,
  input: { limit: number; operation?: string | undefined },
): JournalEntry[] {
  return db
    .query<
      {
        id: number;
        recorded_at: string;
        surface: JournalSurface;
        operation: string;
        input_json: string;
        outcome: JournalOutcome;
        detail: string | null;
      },
      [string | null, number]
    >(
      `SELECT id,recorded_at,surface,operation,input_json,outcome,detail FROM operator_journal
       WHERE mutates=1 AND (?1 IS NULL OR operation=?1) ORDER BY id DESC LIMIT ?2`,
    )
    .all(input.operation ?? null, input.limit)
    .map((row) => ({
      id: row.id,
      recordedAt: row.recorded_at,
      surface: row.surface,
      operation: row.operation,
      input: JSON.parse(row.input_json),
      outcome: row.outcome,
      detail: row.detail,
    }));
}
