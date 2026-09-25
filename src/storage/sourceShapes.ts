import type { Database } from "bun:sqlite";
import { type Shape, shapeHash, shapeOf } from "../shape.js";

/**
 * How many distinct shapes are kept per source. A contract that holds produces one; a source that
 * alternates between two produces two, which is the finding. Past this many the source is not
 * answering with a contract at all, and the oldest are the least useful.
 */
const KEPT_PER_SOURCE = 8;

export type SourceShape = {
  source: string;
  hash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seen: number;
  paths: number;
  shape: Record<string, string>;
  /** How many entries each array path held, as the smallest, the largest and the most recent. */
  counts: Record<string, { min: number; max: number; last: number }>;
};

type Range = { min: number; max: number; last: number };

function mergeCounts(stored: string, observed: Record<string, number>): Record<string, Range> {
  const merged = parse<Record<string, Range>>(stored);
  for (const [path, count] of Object.entries(observed)) {
    const range = merged[path];
    merged[path] = range
      ? { min: Math.min(range.min, count), max: Math.max(range.max, count), last: count }
      : { min: count, max: count, last: count };
  }
  return merged;
}

function parse<T>(text: string): T {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/**
 * Write down the shape of an answer that worked.
 *
 * The caller owns the transaction. Telemetry is never the reason a collection fails, so anything
 * that cannot be walked or serialised is dropped rather than raised.
 */
export function recordSourceShape(db: Database, source: string, value: unknown, at: string): void {
  // Nothing to compare against later, and a collector that returns neither is saying nothing
  // about its upstream's contract.
  if (value === undefined || value === null) return;
  let shape: Shape;
  let hash: string;
  let serialized: string;
  try {
    shape = shapeOf(value);
    hash = shapeHash(shape);
    serialized = JSON.stringify(shape.paths);
  } catch {
    return;
  }
  if (!Object.keys(shape.paths).length) return;
  const existing = db
    .query<{ counts_json: string }, [string, string]>("SELECT counts_json FROM source_shapes WHERE source=? AND hash=?")
    .get(source, hash);
  const counts = JSON.stringify(mergeCounts(existing?.counts_json ?? "{}", shape.counts));
  db.query(
    `INSERT INTO source_shapes(source,hash,first_seen_at,last_seen_at,seen,paths,shape_json,counts_json)
     VALUES(?,?,?,?,1,?,?,?)
     ON CONFLICT(source,hash) DO UPDATE SET
       last_seen_at=excluded.last_seen_at,
       seen=seen+1,
       paths=excluded.paths,
       shape_json=excluded.shape_json,
       counts_json=excluded.counts_json`,
  ).run(source, hash, at, at, Object.keys(shape.paths).length, serialized, counts);
  db.query(
    `DELETE FROM source_shapes
     WHERE source=?
       AND hash NOT IN (SELECT hash FROM source_shapes WHERE source=? ORDER BY last_seen_at DESC LIMIT ?)`,
  ).run(source, source, KEPT_PER_SOURCE);
}

export function listSourceShapes(db: Database, source: string, limit = KEPT_PER_SOURCE): SourceShape[] {
  return db
    .query<
      {
        source: string;
        hash: string;
        first_seen_at: string;
        last_seen_at: string;
        seen: number;
        paths: number;
        shape_json: string;
        counts_json: string;
      },
      [string, number]
    >(
      `SELECT source,hash,first_seen_at,last_seen_at,seen,paths,shape_json,counts_json
       FROM source_shapes WHERE source=? ORDER BY last_seen_at DESC LIMIT ?`,
    )
    .all(source, limit)
    .map((row) => ({
      source: row.source,
      hash: row.hash,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      seen: row.seen,
      paths: row.paths,
      shape: parse<Record<string, string>>(row.shape_json),
      counts: parse<Record<string, Range>>(row.counts_json),
    }));
}

/** What one shape has that another does not, in both directions. The diff a diagnosis needs. */
export function shapeDifference(
  was: Record<string, string>,
  now: Record<string, string>,
): { gone: string[]; arrived: string[]; retyped: string[] } {
  const gone = Object.keys(was).filter((path) => !(path in now));
  const arrived = Object.keys(now).filter((path) => !(path in was));
  const retyped = Object.keys(was).filter((path) => path in now && was[path] !== now[path]);
  return { gone, arrived, retyped };
}
