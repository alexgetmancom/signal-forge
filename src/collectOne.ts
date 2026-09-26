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
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { buildSourceRegistry } from "./sources/registry.js";
import { toWire } from "./sources/subprocess.js";
import { openWithoutMigrating } from "./storage/database.js";

/** This process's peak resident size, which Linux tracks whether or not anybody is watching. */
function peakRssMb(): number {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const kb = Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1]);
    if (Number.isFinite(kb)) return Math.round(kb / 1024);
  } catch {
    // Not Linux -- a development machine. The current size is the closest honest answer.
  }
  return Math.round(process.memoryUsage.rss() / 1024 / 1024);
}

const [id, answerPath] = Bun.argv.slice(2);
if (!id || !answerPath) {
  process.stderr.write("usage: collectOne <source> <answer-file>\n");
  process.exit(2);
}

const config = loadConfig();
const db = openWithoutMigrating(config.DATABASE_URL);

async function answer(): Promise<string> {
  const job = buildSourceRegistry(db, config).find((definition) => definition.id === id);
  // A name the parent has and this process does not means the two are running different code, which
  // is worth saying plainly rather than reporting as a collection that found nothing.
  if (!job) return JSON.stringify({ ok: false, failure: toWire(new Error(`no source named ${id}`)) });
  try {
    return JSON.stringify({ ok: true, collection: await job.collector() });
  } catch (error) {
    return JSON.stringify({ ok: false, failure: toWire(error) });
  }
}

await Bun.write(answerPath, await answer());
// What this collection actually cost, which is the question no stored number answered: the peak is
// read off the kernel's own high-water mark rather than sampled, because a collector that blocks the
// event loop while it parses is invisible to any sampler running on it.
log("info", "Heavy source collected in a child", { source: id, peakRssMb: peakRssMb() });
db.close();
// Explicitly: a collector may leave a socket or a timer behind, and a child that lingers holds the
// memory this whole arrangement exists to give back.
process.exit(0);
