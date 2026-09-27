/**
 * A boot projection, rebuilt in a process of its own.
 *
 * Invoked by src/runtime/rebuildPhase.ts, which is where the reasoning for it is written down; this
 * file is only the other end, and it is the same arrangement src/collectOne.ts is for a heavy
 * collector, src/fingerprintOne.ts for the render fingerprint and src/recapOne.ts for a recap.
 *
 * The phase times and weighs itself here, under the name it has always had: it is one process, one
 * mark and one database, so the figure `timings --name boot` reports goes on being the phase's own
 * claim rather than the parent's view of a child that gave nothing back. It owns its transaction for
 * the same reason the parent used to -- a projection is replaced whole or not at all.
 */
import type { Database } from "bun:sqlite";
import { rebuildHypotheses } from "./hypotheses.js";
import { rebuildModelFacts } from "./modelFacts.js";
import { measure } from "./runtime/metrics.js";
import { peakMb } from "./runtime/peak.js";
import { REBUILD_PHASES, type RebuildPhase } from "./runtime/rebuildPhases.js";
import { openWithoutMigrating } from "./storage/database.js";

const rebuilds: Record<RebuildPhase, (db: Database) => void> = {
  "model-facts": rebuildModelFacts,
  hypotheses: rebuildHypotheses,
};

const [path, phase, answerPath] = Bun.argv.slice(2);
if (!path || !phase || !answerPath || !REBUILD_PHASES.includes(phase as RebuildPhase)) {
  process.stderr.write(`usage: rebuildOne <database> <${REBUILD_PHASES.join("|")}> <answer-file>\n`);
  process.exit(2);
}

// The same handle the other children open: it is the file the service has already migrated, and a
// child has no business having an opinion about the schema version.
const db = openWithoutMigrating(path);
const rebuild = rebuilds[phase as RebuildPhase];
try {
  db.transaction(() => measure(db, `boot.${phase}`, () => rebuild(db)))();
  await Bun.write(answerPath, JSON.stringify({ ok: true, peakRssMb: peakMb() }));
} catch (error) {
  // The class, not the message: a message could carry a line of a record, and nothing upstream is
  // ever stored. The parent describes what this means.
  await Bun.write(answerPath, JSON.stringify({ ok: false, failed: error instanceof Error ? error.name : "unknown" }));
} finally {
  db.close();
}
// Explicitly, as the other children do: a process that lingers holds the memory this whole
// arrangement exists to give back.
process.exit(0);
