/** Per-attempt network counts, isolated across concurrent collectors and retained on failure. */
import { AsyncLocalStorage } from "node:async_hooks";

export type Traffic = {
  requests: number;
  bodyReads: number;
  bytesDecoded: number;
  /** Declared body lengths; null if any read body had no valid Content-Length. */
  bytesWire: number | null;
  notModified: number;
  cacheHits: number;
};

export const emptyTraffic = (): Traffic => ({
  requests: 0,
  bodyReads: 0,
  bytesDecoded: 0,
  bytesWire: 0,
  notModified: 0,
  cacheHits: 0,
});

const storage = new AsyncLocalStorage<Traffic>();

/** The caller owns the tally, so throwing cannot discard what the attempt already spent. */
export function withTraffic<T>(tally: Traffic, run: () => Promise<T>): Promise<T> {
  return storage.run(tally, run);
}

/** Adds to whichever collection is running, or to nothing at all when no collection is. */
function add(change: (tally: Traffic) => void): void {
  const tally = storage.getStore();
  if (tally) change(tally);
}

/** One request put on the wire. Counted before the answer, so a failed ask still counts as asked. */
export function countRequest(): void {
  add((tally) => {
    tally.requests += 1;
  });
}

/** One body read, and what upstream said it would weigh. */
export function countBody(bytesDecoded: number, bytesWire: number | null): void {
  add((tally) => {
    tally.bodyReads += 1;
    tally.bytesDecoded += bytesDecoded;
    tally.bytesWire = tally.bytesWire === null || bytesWire === null ? null : tally.bytesWire + bytesWire;
  });
}

/** An upstream 304, distinct from a cache hit that made no request. */
export function countNotModified(): void {
  add((tally) => {
    tally.notModified += 1;
  });
}

export function countCacheHit(): void {
  add((tally) => {
    tally.cacheHits += 1;
  });
}

/** Two tallies as one, for the parent adding what a child counted in its own process. */
export function mergeTraffic(left: Traffic, right: Traffic): Traffic {
  return {
    requests: left.requests + right.requests,
    bodyReads: left.bodyReads + right.bodyReads,
    bytesDecoded: left.bytesDecoded + right.bytesDecoded,
    bytesWire: left.bytesWire === null || right.bytesWire === null ? null : left.bytesWire + right.bytesWire,
    notModified: left.notModified + right.notModified,
    cacheHits: left.cacheHits + right.cacheHits,
  };
}

/** A tally read back from a child's companion file, with anything unrecognisable dropped. */
export function readTraffic(text: string): Traffic | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (
      ![row.requests, row.bodyReads, row.bytesDecoded, row.notModified, row.cacheHits].every(whole) ||
      (row.bytesWire !== null && !whole(row.bytesWire))
    )
      return null;
    return row as Traffic;
  } catch {
    return null;
  }
}
