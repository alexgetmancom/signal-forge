/**
 * Write the sentences the delivery path never had a chance to write.
 *
 * `fillSummaries` looks only inside unsealed batches, because that is where a sentence is still
 * useful to the card being built. An event whose batch sealed before its turn came -- twenty
 * attempts a cycle, three hundred a day -- leaves that window and never returns to it, however
 * plainly it wanted a sentence. So does every event that was attempted once and got nothing usable
 * back, now that a second attempt is allowed.
 *
 * This walks the events that were actually delivered and summarises the ones with no sentence and
 * attempts to spare, taking the events already attempted once first and then the newest: a week-old
 * card nobody will reopen is the last thing worth paying for. The daily ceiling and the per-event
 * claim are the same ones the delivery path obeys, so a backfill cannot outspend a normal day, and
 * `--limit` bounds one run.
 *
 * Usage: bun scripts/backfill-summaries.ts [--db path] [--days N] [--limit N] [--dry-run]
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import type { Event } from "../src/events/types.js";
import { DEEPSEEK_MAX_ATTEMPTS } from "../src/runtime/deepseekUsage.js";
import { summarizeEvents } from "../src/summary.js";

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
const limit = Number(args.get("--limit") ?? 50);
const dryRun = flags.has("--dry-run");

// Only the readonly case passes options: bun:sqlite answers an explicit `{readonly: false}` with
// SQLITE_MISUSE, so spelling out the default is how this script never once opened for writing.
const db = dryRun ? new Database(resolve(dbPath), { readonly: true }) : new Database(resolve(dbPath));
const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();

// Delivered, because a sentence is for a reader: an event nobody was told about needs none.
const pending = db
  .query<Event & { url: string }, [string]>(
    `SELECT DISTINCT e.*, COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),be.url) AS url
       FROM batch_events be
       JOIN events e ON e.id = be.event_id
      WHERE e.detected_at >= ?
        AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.event_id=e.id)
        AND NOT EXISTS (SELECT 1 FROM deepseek_usage u WHERE u.event_id=e.id
                          AND u.outcome NOT IN ('unclear','failed'))
        AND (SELECT COUNT(*) FROM deepseek_usage u WHERE u.event_id=e.id) < ${DEEPSEEK_MAX_ATTEMPTS}
      ORDER BY (SELECT COUNT(*) FROM deepseek_usage u WHERE u.event_id=e.id) DESC, e.id DESC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
  )
  .all(since);

const retries = pending.filter((event) =>
  Boolean(db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM deepseek_usage WHERE event_id=?").get(event.id)?.n),
);
console.log(`${pending.length} delivered events without a sentence, ${retries.length} of them a second attempt`);
for (const event of pending.slice(0, 10))
  console.log(`  ${event.id}  ${event.stream}/${event.kind}  ${event.source}  ${event.detected_at}`);

if (dryRun) {
  console.log("Dry run: nothing was asked and nothing was claimed.");
  process.exit(0);
}

const written = await summarizeEvents(db, loadConfig(), pending);
console.log(`Wrote ${written} summaries.`);
