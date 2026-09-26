/**
 * Runs the gate. Serial by default so the output reads top to bottom; `--parallel` runs each group
 * at once for the pre-push hook, where wall time is what decides whether the hook survives.
 *
 * `--fast` drops the steps that cannot answer differently for a change to one file -- the
 * dependency audit, the build that recompiles what typecheck just checked, the dead-code pass over
 * the whole tree. A bare word narrows the test run to the files matching it. It is the inner loop,
 * not the gate: the hook and CI run `check --parallel`, which is all of it.
 */
import { resolve } from "node:path";
import { CHECK_GROUPS, type CheckStep } from "./check-steps.js";
import { owedLine, required } from "./rehearsalNeeded.js";

const root = resolve(import.meta.dir, "..");
const parallel = Bun.argv.includes("--parallel");
const fast = Bun.argv.includes("--fast");
// Bun's own argv: [bun, check.ts, ...ours]. Anything that is not a flag names a test file.
const only = Bun.argv.slice(2).filter((value) => !value.startsWith("--"));

async function run(step: CheckStep): Promise<void> {
  const narrowed = step.narrowedBy && only.length > 0 ? [...step.narrowedBy, ...only] : null;
  // `--silent` drops `bun run`'s own two lines -- the `$ <command>` echo before
  // every step and its `error: script "x" exited with code N` after a failing
  // one -- and leaves the script's stdout, its stderr and the exit code alone,
  // which is all this function reads. The echo is not only noise an agent pays
  // to re-read: it goes to stderr, so a `2>&1` in front of a parser makes it
  // the first record and the parse fails on it.
  const child = Bun.spawn(narrowed ?? ["bun", "run", "--silent", ...step.args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`${step.name} failed`);
}

const started = Date.now();
let ran = 0;
for (const group of CHECK_GROUPS) {
  const steps = fast ? group.filter((step) => !step.slow) : group;
  ran += steps.length;
  if (parallel) await Promise.all(steps.map(run));
  else for (const step of steps) await run(step);
}
const skipped = CHECK_GROUPS.flat().length - ran;
// Printed, never failed on: a rehearsal needs a copy of production and the gate has to run without
// one. This is the last thing in the working cycle that was a rule to remember rather than a
// mapping, and a mapping is code.
const changed = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root })
  .stdout.toString()
  .split("\n")
  .map((line) => line.slice(3).trim())
  .filter((file) => file !== "");
const owed = owedLine(required(changed));
process.stderr.write(
  `${owed ? `\n${owed}\n` : ""}` +
    `\nGate passed: ${ran} checks in ${((Date.now() - started) / 1000).toFixed(1)}s` +
    `${only.length > 0 ? `, tests narrowed to ${only.join(" ")}` : ""}` +
    `${skipped ? `, ${skipped} left to the push (--fast)` : ""}\n`,
);
