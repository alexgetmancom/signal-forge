/**
 * Ask Jev the current questions of the whole stored history, not just of yesterday.
 *
 * `judgeEvents` runs each cycle over a day's window, which is right for keeping up and useless for
 * catching up. The judgements are stored per prompt version precisely so a changed prompt can be
 * asked again and the two sets compared -- but a bump to PROMPT_VERSION only reaches the last
 * twenty-four hours, leaving the rest of the retained history answered by the version before it and
 * the comparison impossible to draw.
 *
 * This runs the same function over as many days as asked, a window at a time, until the pending set
 * is empty. It asks only what has no judgement at the current prompt version, so re-running it after
 * an interruption costs nothing, and a run with the prompt unchanged asks nothing at all.
 *
 * Usage: bun scripts/backfill-judgements.ts [--db path] [--days N] [--limit N] [--dry-run]
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { jevCallsToday, judgeEvents } from "../src/jev.js";

const args = new Map<string, string>();
const flags = new Set<string>();
for (let index = 2; index < Bun.argv.length; index += 1) {
  const token = Bun.argv[index] ?? "";
  if (!token.startsWith("--")) continue;
  const next = Bun.argv[index + 1];
  if (next && !next.startsWith("--")) args.set(token, next);
  else flags.add(token);
}
const dbPath = args.get("--db") ?? "./data/app.db";
const days = Number(args.get("--days") ?? 30);
const limit = Number(args.get("--limit") ?? 1_000);
const dryRun = flags.has("--dry-run");

const db = new Database(resolve(dbPath), { readonly: dryRun });
const sinceMs = days * 24 * 3_600_000;

const counts = db
  .query<{ judgeable: number; judged: number }, [string]>(
    `SELECT COUNT(*) judgeable,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM event_evaluations v WHERE v.event_id=e.id AND v.evaluator='jev')
                     THEN 1 ELSE 0 END) judged
       FROM events e
      WHERE e.detected_at >= ?
        AND e.stream IN ('news','pages','web','github','weights','api-models','openrouter','arena')
        AND (e.kind='new' OR (e.stream='web' AND e.kind='changed'))
        AND NOT (e.stream='web' AND e.kind='new')`,
  )
  .get(new Date(Date.now() - sinceMs).toISOString());
console.log(`${counts?.judgeable ?? 0} judgeable events in ${days} days, ${counts?.judged ?? 0} with a judgement`);

if (dryRun) {
  console.log("Dry run: nothing was asked.");
  process.exit(0);
}

// One window at a time, so an interrupted run leaves every judgement it paid for stored.
const config = loadConfig();
let total = 0;
for (;;) {
  const judged = await judgeEvents(db, config, fetch, new Date(), { sinceMs, limit: 40 });
  if (judged === 0) break;
  total += judged;
  console.log(`  ${total} judged, ${jevCallsToday(db)} calls spent today`);
  if (total >= limit) {
    console.log(`Stopping at the ${limit} asked for.`);
    break;
  }
}
console.log(`Judged ${total} events.`);
