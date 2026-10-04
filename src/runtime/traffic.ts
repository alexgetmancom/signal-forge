/**
 * What one collection asked of the network, counted where the asking happens.
 *
 * The question this exists for is which source to narrow next, and it cannot be answered from a
 * body we stored: `snapshots` holds what survived retention, compressed, and says nothing at all
 * about a source that stores none. The only honest place to count is the one both lanes pass
 * through -- `fetchResponse` for the ask and `readResponseBytes` for the answer -- so that is where
 * the counting is, and this module is only the tally the two of them add to.
 *
 * Attribution is ambient rather than a parameter. Collectors call `fetchText` directly and the
 * poller runs several of them at once, so a counter that is not tied to the running collection
 * sums every concurrent source into one number; `AsyncLocalStorage` is what keeps a byte with the
 * collection that asked for it across every await in between. A fetch outside any collection --
 * delivery, a verification probe -- lands in no tally rather than in the wrong one.
 *
 * Nothing here is an upstream value. Counts and byte totals only: no URL, no host, no header, no
 * fragment of a body. The narrowing those numbers lead to is done by a person reading a collector,
 * which is the half that cannot be automated anyway.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One collection's network, as the columns it is stored in. */
export type Traffic = {
  /** Requests actually put on the wire, including the ones that answered 304 or failed. */
  requests: number;
  /** Bytes of body read, after transport decompression: what the collector was handed. */
  bytesDecoded: number;
  /**
   * Bytes upstream said it was sending, summed over the answers that said so.
   *
   * Not the same number as `bytesDecoded` and not a substitute for it: `fetch` decompresses
   * transparently, so a gzipped catalogue is counted here as what crossed the link and there as
   * what had to be held in memory. A source where the two are far apart is already paying its
   * network cost well and its memory cost badly, and one report that cannot tell those apart would
   * send the reader to narrow the wrong thing. Zero where no answer carried a length.
   */
  bytesWire: number;
  /** Answers that carried no body because nothing had changed: a 304, or a fresh cache entry. */
  notModified: number;
};

const empty = (): Traffic => ({ requests: 0, bytesDecoded: 0, bytesWire: 0, notModified: 0 });

const storage = new AsyncLocalStorage<Traffic>();

/**
 * Counts one collection's network and hands back the tally beside its answer.
 *
 * The tally is returned rather than written here because the collection it belongs to is stored in
 * a transaction that may yet fail, and a network total that outlived the attempt it describes would
 * be a row claiming a collection that no report can find.
 */
export async function withTraffic<T>(run: () => Promise<T>): Promise<{ value: T; traffic: Traffic }> {
  const tally = empty();
  const value = await storage.run(tally, run);
  return { value, traffic: tally };
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
export function countBody(bytesDecoded: number, bytesWire: number): void {
  add((tally) => {
    tally.bytesDecoded += bytesDecoded;
    tally.bytesWire += bytesWire;
  });
}

/** One answer that carried no body: upstream had nothing new, or the cached copy was still fresh. */
export function countNotModified(): void {
  add((tally) => {
    tally.notModified += 1;
  });
}

/** Two tallies as one, for the parent adding what a child counted in its own process. */
export function mergeTraffic(left: Traffic, right: Traffic): Traffic {
  return {
    requests: left.requests + right.requests,
    bytesDecoded: left.bytesDecoded + right.bytesDecoded,
    bytesWire: left.bytesWire + right.bytesWire,
    notModified: left.notModified + right.notModified,
  };
}

/** A tally read back from a child's companion file, with anything unrecognisable dropped. */
export function readTraffic(text: string): Traffic | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const whole = (value: unknown): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const row = parsed as Record<string, unknown>;
    return {
      requests: whole(row.requests),
      bytesDecoded: whole(row.bytesDecoded),
      bytesWire: whole(row.bytesWire),
      notModified: whole(row.notModified),
    };
  } catch {
    return null;
  }
}

export const emptyTraffic = empty;
