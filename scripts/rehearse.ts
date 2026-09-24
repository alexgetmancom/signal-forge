/**
 * Measure a policy change against real history before anyone sees it.
 *
 * `scripts/replay-policy.ts` judges the same stored events twice -- once by the policy at a git ref
 * and once by this working tree -- and prints every decision that moved. It had been sitting there
 * unused, because using it meant knowing it existed and then finding a database worth replaying
 * against: its default is `./data/app.db`, the stale copy the project tells everyone never to
 * answer from. Replaying a policy against three-week-old events is worse than not replaying it,
 * since it answers confidently about a history that is not the one we have.
 *
 * So this is that replay with the awkward half done: it copies the live database out of the
 * container, keeps the copy for a few minutes so a second question costs nothing, and replays
 * against that. What it prints is every card a change would have added or held back.
 *
 *   bun run rehearse                       the working tree against HEAD, 30 days
 *   bun run rehearse 60                    a longer window
 *   bun run rehearse 30 discord-signals    including what one channel had already been told
 *   bun run rehearse --base 7e0599f        against the policy as it stood at a commit
 *   bun run rehearse --fresh               ignore the cached copy and pull again
 *
 * Reads only, on both ends.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ssh = process.env.SIGNAL_FORGE_SSH?.trim() || "vm106";
const container = process.env.SIGNAL_FORGE_CONTAINER?.trim() || "signal-forge-app-1";
const root = resolve(import.meta.dir, "..");
const cacheDir = resolve(root, ".rehearsal");
const copy = resolve(cacheDir, "prod.db");
/** Long enough that a follow-up question reuses the copy, short enough that it is still today's. */
const FRESH_FOR_MS = 10 * 60_000;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith("--")));
/** `--base <ref>` names the policy to compare against; everything else is positional. */
const baseAt = argv.indexOf("--base");
const base = baseAt >= 0 ? argv[baseAt + 1] : undefined;
const positional = argv.filter((value, index) => !value.startsWith("--") && index !== baseAt + 1);
const days = positional[0] ?? "30";
const destination = positional[1];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A consistent copy of the live database, gzipped on the wire.
 *
 * The container carries no sqlite3 binary, so the snapshot is taken by the bun already in there:
 * `VACUUM INTO` writes a new file and never touches the one the service is using, and it compacts
 * on the way out -- 435MB became 345MB, and a third of that again over the wire. The script is
 * handed across base64-encoded, because a quoted SQL string inside a shell inside ssh loses a
 * layer of quoting every time somebody edits it.
 */
const SNAPSHOT_SCRIPT = [
  'const { Database } = require("bun:sqlite");',
  'const d = new Database("/app/data/app.db", { readonly: true });',
  `d.exec("VACUUM INTO '/tmp/rehearsal.db'");`,
  "d.close();",
].join(" ");

async function pullSnapshot(into: string): Promise<boolean> {
  const encoded = Buffer.from(SNAPSHOT_SCRIPT).toString("base64");
  const remote = [
    "rm -f /tmp/rehearsal.db",
    `printf %s ${encoded} | base64 -d > /tmp/rehearse.js`,
    "bun /tmp/rehearse.js",
    "gzip -c /tmp/rehearsal.db",
  ].join(" && ");
  // One shell pipeline rather than three plumbed streams: ssh writes, gunzip reads, the file is
  // the shell's business. Wiring the two together through the runtime's own pipes span at 99% of a
  // core and moved nothing, and a copy is not the place to be clever.
  const pipeline = `ssh ${shellQuote(ssh)} ${shellQuote(`docker exec ${container} sh -c ${JSON.stringify(remote)}`)} | gunzip -c > ${shellQuote(into)}`;
  const child = Bun.spawn(["sh", "-c", pipeline], { stdout: "inherit", stderr: "inherit" });
  return (await child.exited) === 0 && existsSync(into) && statSync(into).size > 0;
}

const age = existsSync(copy) ? Date.now() - statSync(copy).mtimeMs : Number.POSITIVE_INFINITY;
if (flags.has("--fresh") || age > FRESH_FOR_MS) {
  mkdirSync(cacheDir, { recursive: true });
  say(`Copying the live database from ${ssh}:${container}`);
  if (!(await pullSnapshot(copy))) {
    say("Could not copy the database. The replay would otherwise answer from a stale one, so it stops here.");
    process.exit(1);
  }
  say(`Copied ${Math.round(statSync(copy).size / 1_000_000)}MB`);
} else {
  say(`Replaying against the copy taken ${Math.round(age / 60_000)} minutes ago (--fresh to pull again)`);
}

const replay = Bun.spawn(
  [
    "bun",
    "scripts/replay-policy.ts",
    "--db",
    copy,
    "--days",
    days,
    ...(base ? ["--base", base] : []),
    ...(destination ? ["--destination", destination] : []),
  ],
  { stdout: "inherit", stderr: "inherit", cwd: root },
);
process.exit(await replay.exited);
