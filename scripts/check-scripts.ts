/**
 * The operator scripts call each other by path, and a path is not type-checked.
 *
 * `scripts/backfill-leaderboards.ts` was deleted once its migration had run, and every check here
 * passed: the only thing still naming it was a line in `deploy.sh`, which runs on the production
 * host. The release stopped the container, failed on the missing module, rolled back, and the
 * defect was a deployment rather than a red gate. This is that gate.
 *
 * Two shapes are followed: a compiled script the release image runs as `dist/scripts/<name>.js`,
 * which must have a `scripts/<name>.ts` behind it, and a shell script installed or invoked by
 * path, which must exist as written.
 *
 * And the same rule one level up: a `bun run` script that nothing describes is a command nobody can
 * find, which is indistinguishable from a command that does not exist. `bun run guide` is where the
 * development commands are described, the way the operation registry describes the operator ones,
 * so every script is either listed there or named as machinery that no person runs directly.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BENCH, benchGaps, scriptNames } from "./workbench.js";

const root = resolve(import.meta.dir, "..");
const shellScripts = readdirSync(`${root}/scripts`).filter((name) => name.endsWith(".sh"));
const problems: string[] = [];

for (const script of shellScripts) {
  const text = readFileSync(`${root}/scripts/${script}`, "utf8");
  for (const [, name] of text.matchAll(/dist\/scripts\/([\w.-]+)\.js/g))
    if (!existsSync(`${root}/scripts/${name}.ts`))
      problems.push(`${script} runs dist/scripts/${name}.js, but scripts/${name}.ts does not exist`);
  for (const [, name] of text.matchAll(/scripts\/([\w.-]+\.sh)/g))
    if (!existsSync(`${root}/scripts/${name}`))
      problems.push(`${script} refers to scripts/${name}, which does not exist`);
}

const gaps = benchGaps(scriptNames(root));
for (const name of gaps.undescribed)
  problems.push(`package.json has a "${name}" script that \`bun run guide\` does not describe`);
for (const name of gaps.stale) problems.push(`\`bun run guide\` describes "${name}", which package.json no longer has`);

if (problems.length) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(
    "A script a release runs is a call site, and a script nobody can find is a script that does not exist.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Script wiring passed: ${shellScripts.length} shell scripts name only scripts that exist, ` +
    `and all ${BENCH.length} commands \`bun run guide\` describes are real.\n`,
);
