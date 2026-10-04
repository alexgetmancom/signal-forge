/**
 * What a migration did to the fields inside stored bodies, and whether a reader would notice.
 *
 * Its own module because `rehearse-migration` is a script that runs on import, and this is the half
 * of its verdict worth testing on its own: the mapping from "these bodies changed" to "this many
 * records will speak to a reader the next time they are collected".
 */
import type { Database } from "bun:sqlite";
import { NOISE } from "../src/events/render/common.js";

/** The top-level field names of every stored body, so a change can be named rather than counted. */
export function bodyFields(db: Database): Map<string, string[]> {
  return new Map(
    db
      .query<{ source: string; id: string; body: string }, []>("SELECT source,id,body FROM records")
      .all()
      .map((row): [string, string[]] => {
        try {
          return [`${row.source} ${row.id}`, Object.keys(JSON.parse(row.body) as Record<string, unknown>)];
        } catch {
          return [`${row.source} ${row.id}`, []];
        }
      }),
  );
}

/** The records already owed a silence, which is what keeps an edited body from becoming a card. */
export function amnestied(db: Database): Set<string> {
  const exists = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='amended_records'")
    .get();
  if (!exists) return new Set();
  return new Set(
    db
      .query<{ source: string; id: string }, []>("SELECT source,id FROM amended_records")
      .all()
      .map((row) => `${row.source} ${row.id}`),
  );
}

export type FieldMove = { field: string; left: number; arrived: number; carriedOnACard: boolean };

/**
 * Which fields this migration took out of stored bodies or put into them, and whether a reader sees
 * one.
 *
 * `recordBodiesChanged` alone is a number to interpret, and interpreting it wrongly is what migration
 * 080 nearly cost: 2,518 bodies lost an `access` field, which is compared like any other and carries
 * a label on a card, so the next collection would have restored it and announced each restoration.
 * A field in NOISE never reaches a card, so losing one moves nothing a reader sees.
 */
export function fieldMoves(
  changed: readonly string[],
  before: Map<string, string[]>,
  after: Map<string, string[]>,
): FieldMove[] {
  const left = new Map<string, number>();
  const arrived = new Map<string, number>();
  for (const key of changed) {
    const was = new Set(before.get(key) ?? []);
    const is = new Set(after.get(key) ?? []);
    for (const field of was) if (!is.has(field)) left.set(field, (left.get(field) ?? 0) + 1);
    for (const field of is) if (!was.has(field)) arrived.set(field, (arrived.get(field) ?? 0) + 1);
  }
  return [...new Set([...left.keys(), ...arrived.keys()])]
    .map((field) => ({
      field,
      left: left.get(field) ?? 0,
      arrived: arrived.get(field) ?? 0,
      carriedOnACard: !NOISE.has(field),
    }))
    .sort((one, other) => other.left + other.arrived - (one.left + one.arrived));
}
