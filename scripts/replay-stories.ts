/**
 * Project the same stored events into stories twice, and report every event that changed story.
 *
 * The gap this fills was found the hard way. `identity.ts` learned to read a model's own name under
 * the host reselling it, which is a change to what shares a story and nothing else; the card replay
 * said "cards changed: 0" and meant it, because it renders each event on its own and never builds
 * the projection, and `rehearse-projections` compares a rebuild with an incremental update inside
 * one tree and so answers a different question. Both passed. The merge was measured by copying the
 * database twice by hand, which is the shape of thing that gets skipped on a Friday.
 *
 * So: two copies, `rebuildStories` from the base tree on one and from this tree on the other, and a
 * comparison of which events ended up together. Ids are allocation order and say nothing, so the
 * fingerprint is over each story's members, and what is printed is the events that moved from one
 * group to another -- a merge where two stories became one, a split where one became two.
 *
 * Reads production's copy, writes only its own two throwaways.
 *
 * Usage: bun scripts/replay-stories.ts [--db path] [--base ref|directory] [--limit N] [--result path]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DATABASE_URL } from "../src/config.js";
import { refuseTheMissingDefault } from "../src/storage/database.js";

type Rebuild = (db: Database) => unknown;
/** A story as the comparison sees it: the key it is filed under and the events filed there. */
type Grouping = Map<string, number[]>;

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) args.set(Bun.argv[index] ?? "", Bun.argv[index + 1] ?? "");
const dbPath = args.get("--db") ?? DEFAULT_DATABASE_URL;
// There is no local database: say so rather than building an empty one and projecting into it.
refuseTheMissingDefault(dbPath);
const base = args.get("--base") ?? "HEAD";
const shown = base.includes("/") ? (base.split("/").pop() as string).slice(0, 12) : base;
const limit = Number(args.get("--limit") ?? 20);
const result = args.get("--result");

async function rebuildAt(ref: string, workspace: string): Promise<Rebuild> {
  const directory = existsSync(join(ref, "src/stories.ts")) ? resolve(ref) : unpack(ref, workspace);
  const module = (await import(join(directory, "src/stories.ts"))) as { rebuildStories?: Rebuild };
  if (!module.rebuildStories) throw new Error(`${ref} has no rebuildStories; choose a later base`);
  return module.rebuildStories;
}

function unpack(ref: string, workspace: string): string {
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", ref, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  const extract = Bun.spawnSync(["tar", "-x", "-C", workspace], { stdin: archive.stdout });
  if (!extract.success) throw new Error(`Unpacking ${ref} failed`);
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  return workspace;
}

/**
 * A writable copy, with the journal beside it.
 *
 * The copy of production is left as it was pulled, so a phase that writes gets its own: a rebuild
 * deletes `story_events` before it starts, and the next phase to read the shared copy would find
 * the projection of whichever tree ran last.
 */
function writableCopy(into: string, name: string): string {
  const path = join(into, name);
  copyFileSync(dbPath, path);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, path + suffix);
  return path;
}

/** Which events each story holds, after a rebuild, keyed by what the story is filed under. */
function grouping(path: string, rebuild: Rebuild): Grouping {
  const db = new Database(path);
  try {
    db.transaction(() => rebuild(db))();
    const rows = db
      .query<{ stable_key: string; event_id: number }, []>(
        "SELECT s.stable_key, e.event_id FROM stories s JOIN story_events e ON e.story_id=s.id ORDER BY s.stable_key, e.event_id",
      )
      .all();
    const groups: Grouping = new Map();
    for (const row of rows) groups.set(row.stable_key, [...(groups.get(row.stable_key) ?? []), row.event_id]);
    return groups;
  } finally {
    db.close();
  }
}

/** The key each event was filed under, which is the comparison: a story's id is allocation order. */
function keyByEvent(groups: Grouping): Map<number, string> {
  const byEvent = new Map<number, string>();
  for (const [key, events] of groups) for (const event of events) byEvent.set(event, key);
  return byEvent;
}

function fingerprint(groups: Grouping): string {
  const digest = createHash("sha256");
  for (const key of [...groups.keys()].sort()) digest.update(`${key}\t${(groups.get(key) as number[]).join(",")}\n`);
  return digest.digest("hex");
}

function shape(groups: Grouping): string {
  const sizes = [...groups.values()].map((events) => events.length);
  const together = sizes.filter((size) => size > 1).length;
  return `${groups.size} stories, ${together} holding more than one event, largest ${Math.max(0, ...sizes)}`;
}

const workspace = mkdtempSync(join(tmpdir(), "signal-forge-stories-"));
try {
  const rebuildBefore = await rebuildAt(base, workspace);
  const rebuildAfter = ((await import("../src/stories.js")) as { rebuildStories: Rebuild }).rebuildStories;
  const before = grouping(writableCopy(workspace, "before.db"), rebuildBefore);
  const after = grouping(writableCopy(workspace, "after.db"), rebuildAfter);

  const was = keyByEvent(before);
  const now = keyByEvent(after);
  const moved = [...new Set([...was.keys(), ...now.keys()])]
    .sort((one, two) => one - two)
    .filter((event) => was.get(event) !== now.get(event));
  // Named by where they ended up, because what a reader of this wants is the story that now exists.
  const byDestination = new Map<string, number[]>();
  for (const event of moved) {
    const key = `${was.get(event) ?? "(none)"} -> ${now.get(event) ?? "(none)"}`;
    byDestination.set(key, [...(byDestination.get(key) ?? []), event]);
  }

  process.stdout.write(
    `${[
      `Story replay: ${shown} -> working tree, every stored event projected by both`,
      `base: ${shape(before)}`,
      `tree: ${shape(after)}`,
      `events filed differently: ${moved.length}`,
      moved.length ? "" : `identical, sha256 ${fingerprint(before).slice(0, 16)} on both sides`,
      "",
      ...[...byDestination.entries()]
        .sort((one, two) => two[1].length - one[1].length)
        .slice(0, limit)
        .map(([move, events]) => `  ${move}\n    ${events.length} events: ${events.slice(0, 8).join(", ")}`),
      ...(byDestination.size > limit ? [`... and ${byDestination.size - limit} more moves (--limit)`] : []),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")}\n`,
  );
  if (result)
    writeFileSync(
      result,
      JSON.stringify({
        phase: "stories",
        verdict: moved.length === 0 ? "same" : "moved",
        moved: moved.length,
        fingerprint: fingerprint(after),
        note: shape(after),
      }),
    );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
