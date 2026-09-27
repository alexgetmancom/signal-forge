/**
 * A period's recap, read in a process of its own.
 *
 * Invoked by src/recap.ts, which is where the reasoning for it is written down; this file is only
 * the other end, and it is the same arrangement src/collectOne.ts is for a heavy collector and
 * src/fingerprintOne.ts is for the render fingerprint. Reading a week claimed 159 MB of a floor that
 * is never given back, measured on a copy of production 2026-09-27, to answer with 1 458 bytes.
 *
 * It writes its answer to the file it is given rather than to stdout, because the logger this
 * process shares with the service writes lines there.
 */
import { type RecapPeriod, recapContext } from "./recap.js";
import { openWithoutMigrating } from "./storage/database.js";

const [path, to, period, answerPath] = Bun.argv.slice(2);
if (!path || !to || !period || !answerPath) {
  process.stderr.write("usage: recapOne <database> <to> <period> <answer-file>\n");
  process.exit(2);
}

// The same handle the other children open, for the same reason: it is the file the service has
// already migrated, and a child has no business having an opinion about the schema version. It only
// reads -- the batch this answer becomes is written by the parent, so the one process that writes
// stays the one process that writes.
const db = openWithoutMigrating(path);
try {
  const context = recapContext(db, to, period as RecapPeriod);
  await Bun.write(answerPath, JSON.stringify({ ok: true, context }));
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
