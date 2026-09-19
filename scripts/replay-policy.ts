/**
 * Replay the delivery policy over stored history and report every decision a change would move.
 *
 * worth.ts and signals.ts are measured knowledge, and until now a change to them was checked by its
 * tests and then by reading the wire for a week. Events are immutable, so the same history can be
 * judged twice: once by the policy at a git ref (HEAD by default) and once by this checkout, and the
 * difference is the change, event by event, before it reaches anyone.
 *
 * Only the destination-independent half is replayed: the rules' class and the standing reason that
 * holds an event back from everyone. What a destination was already told depends on delivery
 * history as it was at the time, which today's database no longer shows faithfully.
 *
 * The database is opened read-only; the base policy is unpacked from git into a temporary directory
 * and nothing in the repository or its refs is touched.
 *
 * Usage: bun scripts/replay-policy.ts [--db path] [--base ref|directory] [--days N] [--limit N]
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Event } from "../src/events/types.js";

type Verdict = { eventId: number; signal: string; reason: string | null };
type Replay = (db: Database, events: readonly Event[]) => Verdict[];

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) args.set(Bun.argv[index] ?? "", Bun.argv[index + 1] ?? "");
const dbPath = args.get("--db") ?? "./data/app.db";
const base = args.get("--base") ?? "HEAD";
const days = Number(args.get("--days") ?? 30);
const limit = Number(args.get("--limit") ?? 60);

/** A git ref, or a directory holding another checkout's src/ (useful where there is no git). */
async function policyAt(ref: string, workspace: string): Promise<Replay> {
  if (existsSync(join(ref, "src/events/batching.ts"))) return load(resolve(ref), ref);
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(["tar", "-x", "-C", workspace], { stdin: archive.stdout });
  if (!unpack.success) throw new Error(`Unpacking ${ref} failed`);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  return load(workspace, ref);
}

async function load(directory: string, ref: string): Promise<Replay> {
  const module = (await import(join(directory, "src/events/batching.ts"))) as { replayVerdicts?: Replay };
  if (!module.replayVerdicts) throw new Error(`${ref} predates replayVerdicts; choose a later base`);
  return module.replayVerdicts;
}

const label = (verdict: Verdict | undefined): string =>
  verdict ? (verdict.reason ? `${verdict.signal} / held: ${verdict.reason}` : `${verdict.signal} / speaks`) : "-";

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-replay-"));
try {
  const before = await policyAt(base, workspace);
  const { replayVerdicts: after } = (await import("../src/events/batching.js")) as { replayVerdicts: Replay };
  const db = new Database(dbPath, { readonly: true });
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  // Judged batch by batch, as they were: a batch's view (renames, known names, listings) is shared.
  const rows = db
    .query<Event & { batch_id: number }, [string]>(
      `SELECT e.*, b.batch_id FROM batch_events b JOIN events e ON e.id=b.event_id
        WHERE e.detected_at>=? ORDER BY b.batch_id, e.id`,
    )
    .all(since);
  const batches = new Map<number, Event[]>();
  for (const row of rows) batches.set(row.batch_id, [...(batches.get(row.batch_id) ?? []), row]);
  const changed: { event: Event; from: Verdict | undefined; to: Verdict | undefined }[] = [];
  let speaksBefore = 0;
  let speaksAfter = 0;
  for (const events of batches.values()) {
    const was = new Map(before(db, events).map((verdict) => [verdict.eventId, verdict]));
    const now = new Map(after(db, events).map((verdict) => [verdict.eventId, verdict]));
    for (const event of events) {
      const from = was.get(event.id);
      const to = now.get(event.id);
      if (from && !from.reason) speaksBefore += 1;
      if (to && !to.reason) speaksAfter += 1;
      if (label(from) !== label(to)) changed.push({ event, from, to });
    }
  }
  const title = (event: Event): string => {
    const record = JSON.parse(event.after_json ?? event.before_json ?? "{}") as { name?: unknown; title?: unknown };
    return String(record.name ?? record.title ?? event.entity_id).slice(0, 80);
  };
  process.stdout.write(
    [
      `Policy replay: ${base} -> working tree, ${days} days, ${rows.length} events in ${batches.size} batches`,
      `speaking (no standing reason): ${speaksBefore} -> ${speaksAfter}`,
      `decisions changed: ${changed.length}`,
      "",
      ...changed
        .slice(0, limit)
        .map(
          ({ event, from, to }) =>
            `#${event.id} [${event.source}] ${title(event)}\n    ${label(from)}  ->  ${label(to)}`,
        ),
      ...(changed.length > limit ? [`... and ${changed.length - limit} more (--limit)`] : []),
      "",
    ].join("\n"),
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
