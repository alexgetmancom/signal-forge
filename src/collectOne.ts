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
import { loadConfig } from "./config.js";
import { buildSourceRegistry } from "./sources/registry.js";
import { toWire } from "./sources/subprocess.js";
import { openWithoutMigrating } from "./storage/database.js";

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
db.close();
// Explicitly: a collector may leave a socket or a timer behind, and a child that lingers holds the
// memory this whole arrangement exists to give back.
process.exit(0);
