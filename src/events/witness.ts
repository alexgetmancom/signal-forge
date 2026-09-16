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

/**
 * Aggregators of other catalogues. A model they carry is already somewhere else, and naming them on
 * a card would say "a list of lists has it" instead of where it can be called.
 */
const MIRRORS = new Set(["models-dev", "truefoundry-azure"]);

/** Which catalogues and registries carry each model, keyed like `subjectKey`. */
export function listingsBySubject(db: Database): Map<string, Set<string>> {
  const listings = new Map<string, Set<string>>();
  const rows = db
    .query<{ source: string; id: string; body: string }, []>(
      "SELECT source,id,body FROM records WHERE stream IN ('api-models','openrouter','weights') AND source NOT LIKE 'discovery:%'",
    )
    .all();
  for (const row of rows) {
    if (MIRRORS.has(row.source)) continue;
    let name: unknown;
    try {
      name = (JSON.parse(row.body) as Record<string, unknown>).name;
    } catch {
      name = null;
    }
    for (const value of new Set([row.id, typeof name === "string" ? name : row.id])) {
      const key = subjectKey(value);
      const sources = listings.get(key) ?? new Set<string>();
      sources.add(row.source);
      listings.set(key, sources);
    }
  }
  return listings;
}

/**
 * How heavily a model is used, as a place in the ranking, for the models that appear on one.
 *
 * Three price lines a week is a budget, and spending one on a model nobody runs is how DeepSeek V4
 * Flash 0731 -- fourth by tokens on the very catalogue that repriced it -- went unmentioned as it
 * got three times cheaper. A model that is not ranked is not disqualified; it simply goes last.
 */
export function usageRanks(db: Database): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const row of db.query<{ body: string }, []>("SELECT body FROM records WHERE source='openrouter-usage'").all()) {
    try {
      const record = JSON.parse(row.body) as { id?: unknown; rank?: unknown };
      const place = Number(record.rank);
      if (typeof record.id === "string" && Number.isFinite(place)) {
        const key = subjectKey(record.id);
        if (!ranks.has(key) || place < (ranks.get(key) ?? place)) ranks.set(key, place);
      }
    } catch {}
  }
  return ranks;
}
