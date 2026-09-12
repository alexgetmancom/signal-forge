import type { Database } from "bun:sqlite";

/**
 * Every mutation an operator made, on whichever surface they made it from.
 *
 * The case this exists for is a delivery whose outcome was decided by hand: the row says `sent`,
 * and nothing else in the database says who decided that, when, or on what evidence. Asking "has
 * anyone already verified this?" before sending anything a second time needs an answer that does
 * not depend on somebody remembering.
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
function serializeInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '"unserializable input"';
  }
}

export function recordOperatorAction(
  db: Database,
  entry: { surface: JournalSurface; operation: string; input: unknown; outcome: JournalOutcome; detail?: string },
  now = Date.now(),
): void {
  db.query(
    "INSERT INTO operator_journal(recorded_at,surface,operation,input_json,outcome,detail) VALUES(?,?,?,?,?,?)",
  ).run(
    new Date(now).toISOString(),
    entry.surface,
    entry.operation,
    serializeInput(entry.input),
    entry.outcome,
    entry.detail ?? null,
  );
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
       WHERE (?1 IS NULL OR operation=?1) ORDER BY id DESC LIMIT ?2`,
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
