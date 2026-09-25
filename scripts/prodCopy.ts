/**
 * A copy of the live database on this machine, and the one place that knows how to get one.
 *
 * Three scripts each had their own idea of where it was, and two of them defaulted to
 * `./data/app.db` -- the stale copy the project tells everyone never to answer from. A copy that is
 * quietly three weeks old is worse than no copy, because it answers confidently.
 *
 * Reads only, on both ends.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ssh = process.env.SIGNAL_FORGE_SSH?.trim() || "vm106";
const container = process.env.SIGNAL_FORGE_CONTAINER?.trim() || "signal-forge-app-1";
const root = resolve(import.meta.dir, "..");
export const cacheDir = resolve(root, ".rehearsal");
export const copy = resolve(cacheDir, "prod.db");
/** Long enough that a follow-up question reuses the copy, short enough that it is still today's. */
const FRESH_FOR_MS = 10 * 60_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * A consistent copy of the live database, gzipped on the wire.
 *
 * The container carries no sqlite3 binary, so the snapshot is taken by the bun already in there:
 * `VACUUM INTO` writes a new file and never touches the one the service is using, and it compacts
 * on the way out -- 435MB became 345MB, and a third of that again over the wire. The script is
 * handed across base64-encoded, because a quoted SQL string inside a shell inside ssh loses a
 * layer of quoting every time somebody edits it.
 */
const SNAPSHOT_SCRIPT = [
  'const { Database } = require("bun:sqlite");',
  'const d = new Database("/app/data/app.db", { readonly: true });',
  `d.exec("VACUUM INTO '/tmp/rehearsal.db'");`,
  "d.close();",
].join(" ");

async function pullSnapshot(into: string): Promise<boolean> {
  const encoded = Buffer.from(SNAPSHOT_SCRIPT).toString("base64");
  const remote = [
    "rm -f /tmp/rehearsal.db",
    `printf %s ${encoded} | base64 -d > /tmp/rehearse.js`,
    "bun /tmp/rehearse.js",
    "gzip -c /tmp/rehearsal.db",
  ].join(" && ");
  // One shell pipeline rather than three plumbed streams: ssh writes, gunzip reads, the file is
  // the shell's business. Wiring the two together through the runtime's own pipes span at 99% of a
  // core and moved nothing, and a copy is not the place to be clever.
  const pipeline = `ssh ${shellQuote(ssh)} ${shellQuote(`docker exec ${container} sh -c ${JSON.stringify(remote)}`)} | gunzip -c > ${shellQuote(into)}`;
  const child = Bun.spawn(["sh", "-c", pipeline], { stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0 && existsSync(into) && statSync(into).size > 0;
}

/**
 * The path to a copy no older than a few minutes, pulling one if there is not already one. Returns
 * null rather than handing back something stale, and says which of the two happened either way.
 */
export async function prodCopy(fresh: boolean, say: (message: string) => void): Promise<string | null> {
  const age = existsSync(copy) ? Date.now() - statSync(copy).mtimeMs : Number.POSITIVE_INFINITY;
  if (!fresh && age <= FRESH_FOR_MS) {
    say(`Using the copy taken ${Math.round(age / 60_000)} minutes ago (--fresh to pull again)`);
    return copy;
  }
  mkdirSync(cacheDir, { recursive: true });
  say(`Copying the live database from ${ssh}:${container}`);
  if (!(await pullSnapshot(copy))) return null;
  say(`Copied ${Math.round(statSync(copy).size / 1_000_000)}MB`);
  return copy;
}

/** Bytes on disk under a path, following directories. */
function weigh(path: string): number {
  if (!existsSync(path)) return 0;
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, entry) => total + weigh(join(path, entry)), 0);
}

/**
 * What a rehearsal leaves behind that it will not need again.
 *
 * `.rehearsal` reached 757MB before anybody looked: a 368MB copy of production, a 376MB working
 * copy of it that the projection rehearsal never deleted, and one unpacked base tree per commit
 * ever rehearsed against. The copy is the expensive one to fetch and is kept; everything derived
 * from it is cheaper to rebuild than to store. `keep` is the base the run just used, because the
 * next run is usually against the same one.
 */
export function sweep(keep: string | null, alsoTheCopy = false): { removed: string[]; freed: number } {
  const removed: string[] = [];
  let freed = 0;
  const drop = (path: string, name: string): void => {
    const size = weigh(path);
    if (size === 0 && !existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
    freed += size;
  };
  for (const suffix of ["", "-wal", "-shm"])
    drop(resolve(cacheDir, `projections.db${suffix}`), `projections.db${suffix}`);
  const bases = resolve(cacheDir, "base");
  if (existsSync(bases))
    for (const sha of readdirSync(bases)) if (sha !== keep) drop(join(bases, sha), `base/${sha.slice(0, 7)}`);
  if (alsoTheCopy) for (const suffix of ["", "-wal", "-shm"]) drop(`${copy}${suffix}`, `prod.db${suffix}`);
  return { removed, freed };
}
