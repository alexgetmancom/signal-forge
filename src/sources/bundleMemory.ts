import type { Database } from "bun:sqlite";
import { readState, writeState } from "../storage/appState.js";

/**
 * What a bundle reader knew last time, kept where another process can find it.
 *
 * These collectors download tens or hundreds of megabytes to keep a handful of model ids, so they
 * only do it when the published version has moved. That used to be remembered in a module-level
 * variable, which was true for as long as the service was one process. Now a heavy collector runs in
 * a child that exits (src/sources/subprocess.ts), so module state is empty on arrival and every hour
 * downloaded the tarball again: 103.5 MB for Claude Code, hourly, to reach the same twenty-three
 * names. Measured 2026-09-26 -- two reads in one process were 5,551 ms and 518 ms, and two in
 * separate processes were 5,523 ms and 5,681 ms.
 *
 * So the memory is the database, which is the same database whichever process is asking. The version
 * is a scalar in `app_state`; the ids are read back from the records that reading produced, the way
 * `npmChannels` reads the channels a package was last accepted at.
 */
export type BundleMemory = {
  /** The version whose bundle was last read through, or null when none was. */
  lastVersion: () => string | null;
  /** The ids that reading produced, empty when there are none stored. */
  ids: () => readonly string[];
  /** Called once a version has been read through, so the next process can skip it. */
  remember: (version: string) => void;
};

/** Nothing remembered: every read downloads. What a test gets unless it says otherwise. */
export const forgetful: BundleMemory = { lastVersion: () => null, ids: () => [], remember: () => {} };

const key = (source: string) => `bundle-version:${source}`;

export function bundleMemory(db: Database, source: string): BundleMemory {
  return {
    lastVersion: () => readState(db, key(source)),
    ids: () =>
      db
        .query<{ id: string }, [string]>("SELECT id FROM records WHERE source=? ORDER BY id")
        .all(source)
        .map((row) => row.id),
    remember: (version: string) => writeState(db, key(source), version),
  };
}
