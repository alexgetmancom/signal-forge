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
 * Two replays, because "what reaches a reader" is two questions: which cards are sent, and what
 * those cards say. The second was added when discord.ts was split and the claim "nothing changes"
 * needed something other than a promise behind it.
 *
 *   bun run rehearse                       the working tree against HEAD, 30 days
 *   bun run rehearse 60                    a longer window
 *   bun run rehearse 30 discord-signals    including what one channel had already been told
 *   bun run rehearse --base 7e0599f        against the policy as it stood at a commit
 *   bun run rehearse --fresh               ignore the cached copy and pull again
 *   bun run rehearse --all                 every phase, including the two that are not about cards
 *   bun run rehearse --only projections    one of them
 *   bun run rehearse --list                what the phases are
 *
 * Every phase shares one copy of production and one unpacked base. Three scripts used to pull
 * 377MB each and `git archive` the same tree twice, which is why two of them quietly defaulted to
 * `./data/app.db` instead. What each phase found is appended to `.rehearsal/ledger.json` under the
 * SHA it was measured against, so a later run can say a fingerprint is the one from four commits
 * ago -- that those four commits reached no reader, which is more than "nothing moved since HEAD".
 *
 * Reads only, on both ends.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { cacheDir, copy, prodCopy } from "./prodCopy.js";
import { appendEntry, type Entry, type Finding, lastAgreement, verdictLine } from "./rehearsalLedger.js";

const root = resolve(import.meta.dir, "..");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith("--")));
/** `--base <ref>` names the policy to compare against; everything else is positional. */
const baseAt = argv.indexOf("--base");
const base = baseAt >= 0 ? argv[baseAt + 1] : undefined;
// `baseAt + 1` is 0 when there is no `--base`, which dropped the first positional: every
// `rehearse 60` since this was written replayed 30 days and said so in a line nobody read against
// what they had typed.
const positional = argv.filter((value, index) => !value.startsWith("--") && !(baseAt >= 0 && index === baseAt + 1));
const days = positional[0] ?? "30";
const destination = positional[1];

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * The base, unpacked once into `.rehearsal/base/<sha>` rather than once per phase.
 *
 * Both replays used to run `git archive` into their own mkdtemp, which is a second unpack of the
 * same tree for no reason, and neither of them could be told to reuse the other's. A directory is
 * a base as far as they are concerned, so they are handed one.
 */
function unpackBase(ref: string): string {
  const sha = resolveRef(ref);
  const into = resolve(cacheDir, "base", sha);
  if (existsSync(join(into, "src/events/batching.ts"))) return into;
  mkdirSync(into, { recursive: true });
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", sha, "src", "package.json"], { cwd: root });
  if (!archive.success) throw new Error(`git archive ${sha} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(["tar", "-x", "-C", into], { stdin: archive.stdout });
  if (!unpack.success) throw new Error(`Unpacking ${sha} failed`);
  if (!existsSync(join(into, "node_modules"))) symlinkSync(join(root, "node_modules"), join(into, "node_modules"));
  return into;
}

function git(...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd: root })
    .stdout.toString()
    .trim();
}

function resolveRef(ref: string): string {
  const sha = git("rev-parse", ref);
  if (!sha) throw new Error(`Not a ref: ${ref}`);
  return sha;
}

type Phase = {
  name: string;
  /** Whether the default run includes it. The two that answer "what reaches a reader" do. */
  always: boolean;
  what: string;
  run: (unpacked: string, resultPath: string) => string[];
};

const PHASES: Phase[] = [
  {
    name: "policy",
    always: true,
    what: "which cards are sent",
    run: (unpacked, resultPath) => [
      "scripts/replay-policy.ts",
      ...["--db", copy, "--days", days, "--base", unpacked, "--result", resultPath],
      ...(destination ? ["--destination", destination] : []),
    ],
  },
  {
    name: "cards",
    always: true,
    what: "what those cards say",
    run: (unpacked, resultPath) => [
      "scripts/replay-cards.ts",
      ...["--db", copy, "--days", days, "--base", unpacked, "--result", resultPath],
    ],
  },
  {
    name: "projections",
    always: false,
    what: "whether an incremental Model Facts or hypotheses update lands where a rebuild does",
    run: () => ["scripts/rehearse-projections.ts"],
  },
  {
    name: "migration",
    always: false,
    what: "what a pending migration does to production's own rows and to the hot reads",
    run: () => ["scripts/rehearse-migration.ts", copy],
  },
];

const only = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] ?? "").split(",") : null;
const chosen = PHASES.filter((phase) => (only ? only.includes(phase.name) : phase.always || flags.has("--all")));

if (flags.has("--list")) {
  for (const phase of PHASES) say(`${phase.always ? " " : "*"} ${phase.name.padEnd(12)} ${phase.what}`);
  say("");
  say("* runs only with --all or --only. Everything above shares one copy of production.");
  process.exit(0);
}
if (chosen.length === 0) {
  say(`No such phase. There are: ${PHASES.map((phase) => phase.name).join(", ")}`);
  process.exit(2);
}

if ((await prodCopy(flags.has("--fresh"), say)) === null) {
  say("Could not copy the database. A rehearsal against a stale one is worse than none, so it stops here.");
  process.exit(1);
}

const unpacked = chosen.some((phase) => phase.always) ? unpackBase(base ?? "HEAD") : "";
const findings: Finding[] = [];
for (const [index, phase] of chosen.entries()) {
  if (index > 0) say("");
  const resultPath = resolve(cacheDir, `${phase.name}.json`);
  rmSync(resultPath, { force: true });
  const child = Bun.spawn(["bun", ...phase.run(unpacked, resultPath)], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: root,
  });
  const code = await child.exited;
  const reported = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, "utf8")) as Finding) : null;
  findings.push(
    reported ?? { phase: phase.name, verdict: code === 0 ? "same" : "failed", moved: 0, fingerprint: null },
  );
  // A phase that could not run says nothing about the change, so the ones after it are not asked.
  if (code !== 0) break;
}

const entry: Entry = {
  at: new Date().toISOString(),
  base: base ?? "HEAD",
  baseSha: unpacked === "" ? "" : resolveRef(base ?? "HEAD"),
  head: resolveRef("HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  days: Number(days),
  findings,
};
const ledger = appendEntry(resolve(cacheDir, "ledger.json"), entry);

say("");
say(verdictLine(entry));
for (const finding of findings) {
  const agreement = lastAgreement(ledger.slice(0, -1), finding);
  if (agreement) say(`  ${agreement}`);
}
if (entry.dirty) say("  (working tree is dirty, so this run is not repeatable from the ledger)");
process.exit(findings.some((finding) => finding.verdict === "failed") ? 1 : 0);
