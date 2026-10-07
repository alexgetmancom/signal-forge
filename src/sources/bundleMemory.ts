import type { Database } from "bun:sqlite";
import { clearState, readState, writeState } from "../storage/appState.js";

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
 * `npmUnchanged` compares the channels with the versions in their accepted records.
 */
export type BundleMemory = {
  /** The version whose bundle was last read through, or null when none was. */
  lastVersion: () => string | null;
  /** The ids that reading produced, empty when there are none stored. */
  ids: () => readonly string[];
  /** Called once a version has been read through, so the next process can skip it. */
  remember: (version: string) => void;
  /**
   * When this version was first found published but not yet readable, stamped on the first ask.
   *
   * npm moves a package's dist-tag before the platform tarball behind it is served, so there is a
   * window where the registry names a version that 404s. Claude Code 2.1.293 spent it failing twice
   * on 2026-10-07. Knowing when the window opened is what separates that from a tarball that is
   * never coming back.
   */
  awaiting: (version: string) => string;
};

/**
 * Nothing remembered: every read downloads. What a test gets unless it says otherwise.
 *
 * `awaiting` answers with the epoch rather than with now, so a memory that remembers nothing never
 * claims a 404 is a publish race it is still inside of. A tolerance is only safe when something can
 * say how long it has been going on, and this cannot.
 */
export const forgetful: BundleMemory = {
  lastVersion: () => null,
  ids: () => [],
  remember: () => {},
  awaiting: () => new Date(0).toISOString(),
};

const key = (source: string) => `bundle-version:${source}`;
const pendingKey = (source: string) => `bundle-pending:${source}`;

/**
 * How long a tarball may 404 after its dist-tag moved before that stops being a publish race.
 *
 * Long enough to cover the registry catching up with itself, short enough that a package which has
 * genuinely moved or been renamed is red within the hour rather than quietly serving the names it
 * read last week. The source keeps answering with what it already knows for this long, which is
 * true -- nothing new has been read -- and goes back to failing loudly after it.
 */
export const PUBLISH_RACE_MS = 15 * 60_000;

/**
 * Whether a version that will not download has been unreadable for less time than a publish takes.
 *
 * True means wait and ask again on the normal interval; false means this is a failure like any
 * other. Either way the version is not remembered, so the next poll downloads it.
 */
export function withinPublishRace(memory: BundleMemory, version: string, now = Date.now()): boolean {
  return now - Date.parse(memory.awaiting(version)) < PUBLISH_RACE_MS;
}

export function bundleMemory(db: Database, source: string): BundleMemory {
  return {
    lastVersion: () => readState(db, key(source)),
    ids: () =>
      db
        .query<{ id: string }, [string]>("SELECT id FROM records WHERE source=? ORDER BY id")
        .all(source)
        .map((row) => row.id),
    remember: (version: string) => {
      writeState(db, key(source), version);
      // Read through, so the window this version may have spent unreadable is closed and the next
      // version starts its own rather than inheriting the elapsed time of this one.
      clearState(db, pendingKey(source));
    },
    awaiting: (version: string) => {
      const stamped = readState(db, pendingKey(source));
      const [pending, at] = stamped ? (JSON.parse(stamped) as [string, string]) : [null, null];
      if (pending === version && at) return at;
      const now = new Date().toISOString();
      writeState(db, pendingKey(source), JSON.stringify([version, now]));
      return now;
    },
  };
}
