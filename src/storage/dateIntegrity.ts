import type { Database } from "bun:sqlite";
import { TIMESTAMP_COLUMNS, TIMESTAMP_GLOB } from "./timestamps.js";

/**
 * The triggers keep badly shaped instants out from now on. They cannot speak for rows written
 * before they existed, and a report drawn from those rows is wrong in the one way nobody checks:
 * it looks like a date.
 */
export type DateViolation = {
  table: string;
  column: string;
  rows: number;
  samples: string[];
};

export type DateIntegrityReport = {
  ok: boolean;
  checkedColumns: number;
  violations: DateViolation[];
  expectedShape: string;
};

export function dateIntegrity(db: Database, sampleLimit = 10): DateIntegrityReport {
  const violations: DateViolation[] = [];
  for (const [table, column] of TIMESTAMP_COLUMNS) {
    const rows = db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT GLOB ?`,
      )
      .get(TIMESTAMP_GLOB)?.count;
    if (!rows) continue;
    violations.push({
      table,
      column,
      rows,
      samples: db
        .query<{ value: string }, [string, number]>(
          `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT GLOB ? LIMIT ?`,
        )
        .all(TIMESTAMP_GLOB, sampleLimit)
        .map((row) => row.value),
    });
  }
  return {
    ok: violations.length === 0,
    checkedColumns: TIMESTAMP_COLUMNS.length,
    violations,
    expectedShape: "ISO-8601 UTC, for example 2026-09-12T18:35:20.000Z",
  };
}
