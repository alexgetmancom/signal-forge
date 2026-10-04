/**
 * One source, collected in a process of its own, for the heavy lane.
 *
 * Invoked by src/sources/subprocess.ts, which is where the reasoning for it is written down; this
 * file is only the other end. It writes its answer to the file it is given rather than to stdout,
 * because the logger this process shares with the service writes lines there.
 *
 * It opens the database the service has already migrated, without migrating it, so a collector that
 * reads what was stored last time -- npm asks which channels it has seen -- still can.
 */
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { peakMb } from "./runtime/peak.js";
import { withTraffic } from "./runtime/traffic.js";
import { buildSourceRegistry } from "./sources/registry.js";
import { toWire } from "./sources/subprocess.js";
import { openWithoutMigrating } from "./storage/database.js";

const [id, answerPath] = Bun.argv.slice(2);
if (!id || !answerPath) {
  process.stderr.write("usage: collectOne <source> <answer-file> (configuration on stdin)\n");
  process.exit(2);
}

const config = (await Bun.stdin.json()) as AppConfig;
const db = openWithoutMigrating(config.DATABASE_URL);

async function answer(): Promise<Record<string, unknown>> {
  const job = buildSourceRegistry(db, config).find((definition) => definition.id === id);
  // A name the parent has and this process does not means the two are running different code, which
  // is worth saying plainly rather than reporting as a collection that found nothing.
  if (!job) return { ok: false, failure: toWire(new Error(`no source named ${id}`)) };
  try {
    return { ok: true, collection: await job.collector() };
  } catch (error) {
    return { ok: false, failure: toWire(error) };
  }
}

// The tally is taken around the whole answer, failures included: what a collector asked of the
// network before it threw is still what it cost, and the parent stamps it onto the failed attempt.
const { value: outcome, traffic } = await withTraffic(answer);
// Serialising the collection can cost more memory than fetching it. The peak is taken after the
// answer is written, then sent in a small companion file so the measurement includes that work.
await Bun.write(answerPath, JSON.stringify(outcome));
const peakRssMb = peakMb();
await Bun.write(`${answerPath}.peak`, String(peakRssMb));
// A companion file rather than a field of the answer, so that a failed collection carries its
// network cost home too; the parent deletes all three.
await Bun.write(`${answerPath}.traffic`, JSON.stringify(traffic));
log("info", "Heavy source collected in a child", { source: id, peakRssMb });
db.close();
// Explicitly: a collector may leave a socket or a timer behind, and a child that lingers holds the
// memory this whole arrangement exists to give back.
process.exit(0);
