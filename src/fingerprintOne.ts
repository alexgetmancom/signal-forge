/**
 * What this build renders, hashed in a process of its own.
 *
 * Invoked by src/reports/releaseRender.ts, which is where the reasoning for it is written down; this
 * file is only the other end, and it is the same arrangement src/collectOne.ts is for a heavy
 * collector. Rendering every event of the corpus at both detail levels claimed 56 MB of a floor that
 * is never given back, measured on a copy of production 2026-09-27, to answer with 600 bytes -- and
 * unlike the reads that were rewritten around it, that allocation is the task rather than an
 * oversight: the cards have to be built to be hashed. What can be given back is the process.
 *
 * It writes its answer to the file it is given rather than to stdout, because the logger this
 * process shares with the service writes lines there.
 */
import { renderFingerprint } from "./reports/releaseRender.js";
import { openWithoutMigrating } from "./storage/database.js";

const [path, corpusJson, answerPath] = Bun.argv.slice(2);
if (!path || !corpusJson || !answerPath) {
  process.stderr.write("usage: fingerprintOne <database> <corpus-json> <answer-file>\n");
  process.exit(2);
}

// The same handle a collecting child opens, for the same reason: it is the file the service has
// already migrated, and a child has no business having an opinion about the schema version. It only
// reads -- the rows this produces are written by the parent, so the one process that writes stays
// the one process that writes.
const db = openWithoutMigrating(path);
try {
  const fingerprint = renderFingerprint(db, JSON.parse(corpusJson) as Parameters<typeof renderFingerprint>[1]);
  await Bun.write(
    answerPath,
    JSON.stringify({
      ok: true,
      hash: fingerprint.hash,
      cards: fingerprint.cards,
      tookMs: fingerprint.tookMs,
      byEvent: [...fingerprint.byEvent],
    }),
  );
} catch (error) {
  // The class, not the message. A card that throws is already part of the fingerprint; what is
  // reported here is this process failing to produce one at all, and the parent describes it.
  await Bun.write(answerPath, JSON.stringify({ ok: false, failed: error instanceof Error ? error.name : "unknown" }));
} finally {
  db.close();
}
// Explicitly, as the collector child does: a process that lingers holds the memory this whole
// arrangement exists to give back.
process.exit(0);
