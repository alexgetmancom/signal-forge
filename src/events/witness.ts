import type { Database } from "bun:sqlite";
import { modelSubject } from "./variants.js";

/**
 * Models something other than a price list knows about.
 *
 * A catalogue reprices hundreds of rows and most of them are models nobody here has heard of. In
 * the week of 8 September, Qwen3 14B -- a small dense model from April 2025 -- moved 3.8 times on
 * OpenRouter because the cheapest provider serving it changed, and won the recap's price line from
 * DeepSeek V3.1 actually getting 55% cheaper. Six days later it moved back to the exact figure it
 * started from.
 *
 * The floor is evidence, not taste: a benchmark ranks it, an arena serves it, or its own maker
 * lists it in their API. A row that exists only in a reseller's price list has one collector's word
 * that it matters, and that is not enough to spend one of three lines a week on.
 */

/** A subject reduced until two spellings of one model meet: `solar-pro4-20260805` and `Upstage: Solar Pro 4`. */
export function subjectKey(name: string): string {
  return modelSubject(name)
    .replace(/\s+\d{8}$/, "")
    .replace(/\s+/g, "");
}

export function witnessedSubjects(db: Database): Set<string> {
  const witnessed = new Set<string>();
  // Where a model is known by something other than the catalogue selling it: a benchmark ranks it,
  // an arena serves it, or its own maker lists it.
  const rows = db
    .query<{ body: string }, []>("SELECT body FROM records WHERE stream IN ('leaderboards','arena','api-models')")
    .all();
  for (const row of rows) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const value of [record.name, record.model, record.modelKey, record.id])
      if (typeof value === "string" && value.trim()) witnessed.add(subjectKey(value));
  }
  return witnessed;
}
