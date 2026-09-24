import type { Database } from "bun:sqlite";

/**
 * Which commands this deployment is actually operated with, and which questions it could not answer.
 *
 * Nobody but an agent touches this repository, so the journal is a record of how the tooling is
 * really used rather than how it was meant to be. Two things come out of it that nothing else says.
 *
 * The first is the gap. `sql` is the command for a question no command answers, so every recurring
 * `sql` query is a command that should exist: it had been called 558 times against a registry of
 * fifty commands before anybody looked. The shapes below are those queries with their literals
 * removed, so the same question asked about a different source counts as the same question.
 *
 * The second is the cost of being wrong. A command that keeps failing is a command whose arguments
 * are not guessable from its usage line, and the error is the evidence for what to fix.
 */
export type UsageReport = {
  window: { from: string; calls: number };
  commands: { operation: string; surface: string; calls: number; failures: number; maxMs: number | null }[];
  askedByHand: { shape: string; asked: number; lastAsked: string; example: string }[];
  failing: { operation: string; failures: number; lastDetail: string | null }[];
};

/**
 * One query stands for another when only its literals differ.
 *
 * Numbers, quoted strings and the interval in a `datetime('now', ...)` are the parts that change
 * between two askings of the same question; whitespace is noise. What is left is the shape, and a
 * shape asked more than once is a report waiting to be written.
 */
export function queryShape(query: string): string {
  return query
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

const WINDOW_DAYS = 30;

export function usageReport(db: Database, days = WINDOW_DAYS, now = Date.now()): UsageReport {
  const from = new Date(now - days * 24 * 3_600_000).toISOString();
  const rows = db
    .query<
      {
        operation: string;
        surface: string;
        input_json: string;
        outcome: string;
        detail: string | null;
        recorded_at: string;
        duration_ms: number | null;
      },
      [string]
    >(
      `SELECT operation,surface,input_json,outcome,detail,recorded_at,duration_ms
       FROM operator_journal WHERE recorded_at >= ? ORDER BY id`,
    )
    .all(from);

  const commands = new Map<
    string,
    { operation: string; surface: string; calls: number; failures: number; maxMs: number | null }
  >();
  const shapes = new Map<string, { shape: string; asked: number; lastAsked: string; example: string }>();
  const failing = new Map<string, { operation: string; failures: number; lastDetail: string | null }>();

  for (const row of rows) {
    const key = `${row.operation}\u0000${row.surface}`;
    const command = commands.get(key) ?? {
      operation: row.operation,
      surface: row.surface,
      calls: 0,
      failures: 0,
      maxMs: null,
    };
    command.calls++;
    if (row.outcome !== "ok") command.failures++;
    if (row.duration_ms !== null) command.maxMs = Math.max(command.maxMs ?? 0, row.duration_ms);
    commands.set(key, command);

    if (row.outcome === "failed") {
      const seen = failing.get(row.operation) ?? { operation: row.operation, failures: 0, lastDetail: null };
      seen.failures++;
      seen.lastDetail = row.detail;
      failing.set(row.operation, seen);
    }

    if (row.operation !== "sql") continue;
    let query: string;
    try {
      query = String((JSON.parse(row.input_json) as { query?: unknown }).query ?? "");
    } catch {
      continue;
    }
    if (!query) continue;
    const shape = queryShape(query);
    const asked = shapes.get(shape) ?? { shape, asked: 0, lastAsked: row.recorded_at, example: query.slice(0, 400) };
    asked.asked++;
    asked.lastAsked = row.recorded_at;
    shapes.set(shape, asked);
  }

  return {
    window: { from, calls: rows.length },
    commands: [...commands.values()].sort((left, right) => right.calls - left.calls),
    // Asked once is a one-off; asked again is a pattern, and only patterns are worth a command.
    askedByHand: [...shapes.values()]
      .filter((shape) => shape.asked > 1)
      .sort((left, right) => right.asked - left.asked),
    failing: [...failing.values()].sort((left, right) => right.failures - left.failures),
  };
}
