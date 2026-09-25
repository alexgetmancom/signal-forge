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
  askedByHand: {
    shape: string;
    asked: number;
    lastAsked: string;
    example: string;
    /** A command that already reads these tables, if there is one. See `COVERED_BY`. */
    coveredBy: string | null;
  }[];
  failing: { operation: string; failures: number; lastDetail: string | null }[];
};

/**
 * The tables a query reads, which is the grain a command is written at.
 *
 * Removing the literals was not enough. Ten of the twenty-two `sql` calls made on 2026-09-25 asked
 * the same question of `code_metrics`, and the shapes collapsed two of them, because the column
 * lists differed -- `SELECT name, calls` and `SELECT name, calls, max_duration_ms` are one question
 * to a person and two strings to a `replace`. A detector that misses eight of ten repeats is a
 * detector that says there is nothing to write.
 *
 * A command is almost never about a projection; it is about a table, or two joined. So that is the
 * grain: the set of tables, and whether the question was aggregated, because "how many" and "which
 * ones" are different commands. The example query is kept alongside for the part this throws away.
 */
export function queryShape(query: string): string {
  const normalized = query
    .replace(/'[^']*'/g, "'?'")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const tables = [
    ...new Set(
      [...normalized.matchAll(/\b(?:from|join|into|update)\s+([a-z_][\w]*)/g)]
        .map((match) => match[1] as string)
        // A subquery's `FROM (` and the alias of a common table expression are not tables.
        .filter((name) => name !== "select"),
    ),
  ].sort();
  const grouped = /\bgroup\s+by\b/.test(normalized) || /\b(?:count|sum|avg|min|max)\s*\(/.test(normalized);
  if (!tables.length) return normalized.slice(0, 200);
  return `${tables.join(" + ")}${grouped ? " (aggregated)" : ""}`;
}

/**
 * Tables that an existing command already answers for.
 *
 * The gap detector can only see a question nothing answers. It cannot see the other failure, which
 * is the one that actually happened: `code_analytics` reported duration percentiles for months, was
 * listed to every agent, and ten raw queries were still written against `code_metrics` by hand --
 * because it sat in the `sources` section under the name of the table rather than the name of the
 * question. A command nobody finds and a command that does not exist look identical from here, and
 * only one of them is fixed by writing more code.
 *
 * Keep this honest rather than complete: an entry claims that the named command answers the usual
 * question about that table, and a wrong entry is worse than a missing one.
 */
const COVERED_BY: Readonly<Record<string, string>> = {
  code_metrics: "timings",
  source_collection_metrics: "flaky, failures, outages",
  sources: "issues, silent-sources, sources",
  operator_journal: "usage, journal",
  deliveries: "destinations, delivery-health",
  source_failure_evidence: "failures",
  hypotheses: "hypotheses",
  model_facts: "model-facts",
  snapshots: "snapshot",
};

/**
 * Which command already answers the usual question about the tables this query reads.
 *
 * Exported because the useful moment to say it is not here. `usage` reports it days later, to
 * whoever thinks to ask; `sql` can say it in the same breath as the answer, to the person who just
 * wrote the query. Over two weeks 38 of 44 `sql` calls on production had one of these, which is to
 * say the registry was never missing a command -- it was missing at the moment of the question.
 */
export function coveredBy(shape: string): string | null {
  const named = [...new Set(shape.replace(/ \(aggregated\)$/, "").split(" + "))]
    .map((table) => COVERED_BY[table])
    .filter((command): command is string => command !== undefined);
  return named.length ? [...new Set(named)].join("; ") : null;
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
  const shapes = new Map<string, UsageReport["askedByHand"][number]>();
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
    const asked = shapes.get(shape) ?? {
      shape,
      asked: 0,
      lastAsked: row.recorded_at,
      example: query.slice(0, 400),
      coveredBy: coveredBy(shape),
    };
    asked.asked++;
    asked.lastAsked = row.recorded_at;
    shapes.set(shape, asked);
  }

  return {
    window: { from, calls: rows.length },
    commands: [...commands.values()].sort((left, right) => right.calls - left.calls),
    // Asked once is a one-off; asked again is a pattern. A pattern with `coveredBy` set is not a
    // command to write but a command to make findable, which is the cheaper of the two fixes.
    askedByHand: [...shapes.values()]
      .filter((shape) => shape.asked > 1)
      .sort((left, right) => right.asked - left.asked),
    failing: [...failing.values()].sort((left, right) => right.failures - left.failures),
  };
}
