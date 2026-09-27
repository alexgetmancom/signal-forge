/**
 * A boot projection, rebuilt where the memory it takes can be given back.
 *
 * A boot is the worst moment this process ever has, and `VmHWM` is never lowered, so what a phase
 * adds to the mark there is the floor the service stands on until it is restarted. Measured on
 * production, `boot.model-facts` claimed 95.8 MB of it and `boot.hypotheses` 37.7 -- 134 MB held for
 * the life of the process to write tables that are read from SQLite afterwards and never from memory.
 * The story projection is the one phase that cannot move: the poller extends it in place, so the
 * process that builds it has to be the process that keeps it.
 *
 * What the child gives back is the tables it wrote, which is all these two phases ever produced, so
 * nothing crosses but a yes. It times and weighs itself under the name it has always had, in the
 * same database, which is why `timings --name boot` keeps its ninety days of history rather than
 * starting a second series beside the first.
 *
 * The figure means something different on either side of this change, and the guide for `timings`
 * says so: it was what the phase added to the floor of the service, and it is now the mark of a
 * process that ends. It went up, not down -- 95.8 MB became 162.7 for Model Facts on the first boot
 * that ran it here -- because a child pays its own startup into its own mark and has none of the
 * parent's warm allocator. What the service keeps is the number in `memory`, and that is where this
 * is worth reading.
 *
 * Each child owns its transaction, and the parent holds none while it runs: two connections and one
 * write lock, so a parent still inside `db.transaction` would be a child waiting for a lock the
 * parent will not release until the child answers. That is also why the phases run one after
 * another -- and it is the safe order anyway, because two rebuilds at once are two marks on one
 * container.
 *
 * A failure is raised. These projections are what every report reads; a boot that could not rebuild
 * one is a boot that should end, and the container restarting is the repair.
 */
import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { measure } from "./metrics.js";
import type { RebuildPhase } from "./rebuildPhases.js";

/** How long a child gets before it is killed. The longer of the two takes 1.6 s on production. */
const REBUILD_TIMEOUT_MS = 600_000;

/** Where the child lives, beside this module's own compiled form rather than at a guessed path. */
function entry(): string {
  const name = import.meta.url.endsWith(".ts") ? "../rebuildOne.ts" : "../rebuildOne.js";
  return new URL(name, import.meta.url).pathname;
}

/** What the child writes down: that it rebuilt the phase, and the mark it reached doing it. */
type WireRebuild = { ok: true; peakRssMb: number } | { ok: false; failed: string };

export async function rebuildInAChild(db: Database, phase: RebuildPhase, inThisProcess: () => void): Promise<void> {
  // No file is a test or a probe against `:memory:`, where there is nothing to hand a child and no
  // long-lived process whose floor this protects.
  if (!db.filename || db.filename === ":memory:") {
    measure(db, `boot.${phase}`, inThisProcess);
    return;
  }
  const answerPath = join(tmpdir(), `signal-forge-rebuild-${phase}-${Bun.nanoseconds()}.json`);
  const child = Bun.spawn([process.execPath, "--smol", entry(), db.filename, phase, answerPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill(), REBUILD_TIMEOUT_MS);
  try {
    const code = await child.exited;
    const file = Bun.file(answerPath);
    const answer = (await file.exists()) ? (JSON.parse(await file.text()) as WireRebuild) : null;
    // What a runtime prints when it dies is not something to store or to publish, so a child that
    // did not answer is described by how it ended, as a collector's is.
    if (!answer)
      throw new Error(
        `${phase} was not rebuilt: the child ${code === null ? "was killed" : `exited with code ${code}`} without answering`,
      );
    if (!answer.ok) throw new Error(`${phase} was not rebuilt: the child raised ${answer.failed}`);
    log("info", "Boot projection rebuilt in a child", { phase, peakRssMb: answer.peakRssMb });
  } finally {
    clearTimeout(timer);
    try {
      unlinkSync(answerPath);
    } catch {
      // The child may never have written it, and a temporary file left behind is not a failure.
    }
  }
}
