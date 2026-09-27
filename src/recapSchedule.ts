import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, Destination } from "./config.js";
import { featureEnabled } from "./features.js";
import { lastRecapPeriod, PERIODS, type RecapPeriod } from "./recap/reading.js";
import { type RecapContext, recapContextSchema } from "./recap/schema.js";
import { recapContext } from "./recap.js";

/**
 * Queueing a period's recap: the half of a recap that starts a process and writes rows.
 *
 * The reading is src/recap.ts, which a renderer imports for the schema alone. This side spawns the
 * child that does the reading, gives it a deadline and a file to answer in, and inserts the batch
 * and its targets -- none of which a reader of a stored context needs to have loaded.
 */

/** How long the child gets before it is killed. Reading a week takes under two seconds. */
const RECAP_TIMEOUT_MS = 120_000;

/** Where the child lives, beside this module's own compiled form rather than at a guessed path. */
function recapEntry(): string {
  const name = import.meta.url.endsWith(".ts") ? "./recapOne.ts" : "./recapOne.js";
  return new URL(name, import.meta.url).pathname;
}

/** What the child writes down: the context as the schema below parses it, or how it failed. */
type WireRecap = { ok: true; context: unknown } | { ok: false; failed: string };

/**
 * The reading, done in a process that ends.
 *
 * A period's lines are each a filter over every event of the period, and the reading they share
 * holds all of them: a week claimed 159 MB on a copy of production 2026-09-27 to answer with 1 458
 * bytes, a day and the news 58 each. Inside the poller that is 159 MB of floor for the life of the
 * service, taken once, on the first five-minute tick after a Sunday evening -- and RSS is a
 * high-water mark, so it is never given back and nothing later in the report says where it went.
 * In a child it dies with the child, which is what src/sources/subprocess.ts does for a heavy
 * collector and src/reports/releaseRender.ts for the render fingerprint.
 *
 * The answer crosses as JSON and is parsed by the same schema that reads a stored batch, so a child
 * that answered with something else is a failure here rather than a batch nobody can render.
 *
 * A failure is raised rather than quietly read in this process instead. A fallback would be
 * invisible -- the answer is the same either way, and the floor it exists to hold down would be back.
 */
async function recapContextThatEnds(db: Database, to: string, period: RecapPeriod): Promise<RecapContext> {
  // No file is a test or a probe against `:memory:`, where there is nothing to hand a child and no
  // long-lived process whose floor this protects.
  if (!db.filename || db.filename === ":memory:") return recapContext(db, to, period);
  const answerPath = join(tmpdir(), `signal-forge-recap-${Bun.nanoseconds()}.json`);
  const child = Bun.spawn([process.execPath, "--smol", recapEntry(), db.filename, to, period, answerPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill(), RECAP_TIMEOUT_MS);
  try {
    const code = await child.exited;
    const file = Bun.file(answerPath);
    const answer = (await file.exists()) ? (JSON.parse(await file.text()) as WireRecap) : null;
    // What a runtime prints when it dies is not something to store or to publish, so a child that
    // did not answer is described by how it ended, as a collector's is.
    if (!answer)
      throw new Error(
        `The ${period} recap was not read: the child ${code === null ? "was killed" : `exited with code ${code}`} without answering`,
      );
    if (!answer.ok) throw new Error(`The ${period} recap was not read: the child raised ${answer.failed}`);
    return recapContextSchema.parse(answer.context);
  } finally {
    clearTimeout(timer);
    try {
      unlinkSync(answerPath);
    } catch {
      // The child may never have written it, and a temporary file left behind is not a failure.
    }
  }
}

/**
 * Queue the recaps for the periods that have just ended, once each.
 *
 * The week goes to the destinations that carry launches, which is the wire a reader follows for
 * what they can use. The day goes to the destinations that carry sightings: the invited room sees
 * every event as it happens, and what it does not see is the small movement that never speaks.
 *
 * In sequence rather than at once: each period's reading is the largest claim this process makes
 * outside a boot, and two of them running together would be two of them on the mark.
 */
export async function scheduleRecaps(db: Database, config: AppConfig, now = Date.now()): Promise<RecapPeriod[]> {
  const queued: RecapPeriod[] = [];
  for (const period of Object.keys(PERIODS) as RecapPeriod[])
    if (await scheduleRecap(db, config, period, now)) queued.push(period);
  return queued;
}

async function scheduleRecap(db: Database, config: AppConfig, period: RecapPeriod, now: number): Promise<boolean> {
  const { source, signals, feature } = PERIODS[period];
  if (!featureEnabled(config, feature)) return false;
  const readyAt = lastRecapPeriod(now, period);
  const targets = (config.destinations as Destination[]).filter((destination) =>
    signals.some((signal) => destination.signals.includes(signal)),
  );
  if (!targets.length) return false;
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM batches WHERE kind='weekly_recap' AND source=? AND ready_at=?",
    )
    .get(source, readyAt);
  if (existing) return false;
  const context = await recapContextThatEnds(db, readyAt, period);
  // A period in which nothing arrived, nothing moved and nothing was sighted is not worth a message;
  // a day is only ever about what moved.
  const empty =
    period === "news"
      ? !context.headlines.length
      : period === "day"
        ? !context.leaders.length &&
          !context.climbers.length &&
          !context.newBoards.length &&
          !context.resellerArrivals.length &&
          !context.codeNotes.length &&
          !context.indexed.length
        : !context.arrivalCount &&
          !context.priceMoves.length &&
          !context.codenameCount &&
          !context.retirements.length &&
          !context.retirementNotes.length;
  if (empty) return false;
  const batch = db
    .query<{ id: number }, [string, string, string]>(
      "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,0,?,'weekly_recap',?) RETURNING id",
    )
    .get(source, readyAt, JSON.stringify(context));
  if (!batch) throw new Error("Recap batch insert failed");
  for (const destination of targets)
    db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
      batch.id,
      destination.id,
      JSON.stringify(destination),
    );
  return true;
}
