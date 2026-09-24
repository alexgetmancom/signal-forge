/**
 * Push, watch the release through, and prove it reached the container.
 *
 *   bun run ship [symbol]
 *
 * Deploying is four steps that are always the same four: push, find the run that belongs to this
 * commit, watch it, then look inside the container for something only the new code has. Done by
 * hand it is the last step that gets skipped, and it is the one that answers the question: CI
 * going green says the image built, not that the host is running it.
 *
 * The run is resolved by head SHA rather than by being the newest, because two pushes a minute
 * apart otherwise watch each other's run and report the wrong verdict.
 *
 * `symbol` is a name only the new code contains -- a constant, a function. Without one, the names
 * this push added are read out of the diff, and when there are none the deployment is reported as
 * unverified rather than as done.
 */
const ssh = process.env.SIGNAL_FORGE_SSH?.trim() || "vm106";
const container = process.env.SIGNAL_FORGE_CONTAINER?.trim() || "signal-forge-app-1";
/** How long the container is given to restart on the new image once CI is green. */
const RESTART_ATTEMPTS = 20;
const RESTART_WAIT_MS = 15_000;

async function run(command: string[]): Promise<{ ok: boolean; out: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: (await child.exited) === 0, out: `${out}${error}`.trim() };
}

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

function fail(message: string): never {
  say(message);
  process.exit(1);
}

/** Names this push added, most distinctive first: a long identifier is a better probe than `id`. */
async function addedSymbols(range: string): Promise<string[]> {
  const diff = await run(["git", "diff", "-U0", range, "--", "src/", "scripts/"]);
  const names = new Set<string>();
  for (const line of diff.out.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const [, name] of line.matchAll(/(?:const|let|function|class|type|interface)\s+([A-Za-z_][\w]{5,})/g))
      if (name) names.add(name);
  }
  return [...names].sort((a, b) => b.length - a.length);
}

const argument = Bun.argv[2];
const branch = (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"])).out;
const before = (await run(["git", "rev-parse", "@{upstream}"])).out;
const push = await run(["git", "push"]);
if (!push.ok) fail(push.out);
const sha = (await run(["git", "rev-parse", "HEAD"])).out;
say(`pushed ${sha.slice(0, 8)} on ${branch}`);

// The run appears a moment after the push, so it is asked for rather than expected.
let runId = "";
for (let attempt = 0; attempt < 10 && !runId; attempt++) {
  const listed = await run([
    "gh",
    "run",
    "list",
    "-L",
    "10",
    "--json",
    "databaseId,headSha",
    "-q",
    `.[] | select(.headSha=="${sha}") | .databaseId`,
  ]);
  runId = listed.out.split("\n")[0]?.trim() ?? "";
  if (!runId) await Bun.sleep(5_000);
}
if (!runId) fail(`No workflow run for ${sha}`);
say(`run ${runId}, watching`);
// `gh run watch` has its own ways to fail -- a run it cannot see yet, a poll that dropped -- and
// once it reported a red build over a run whose three jobs had all passed. The verdict is the
// conclusion the run itself carries; watching is only how the waiting is done.
const watched = await run(["gh", "run", "watch", runId, "--exit-status"]);
const conclusion = (await run(["gh", "run", "view", runId, "--json", "conclusion", "-q", ".conclusion"])).out;
if (!watched.ok && conclusion !== "success")
  fail(
    `CI ${conclusion || "did not finish"}: https://github.com/${(await run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).out}/actions/runs/${runId}`,
  );
say("CI green");

const symbols = argument ? [argument] : await addedSymbols(`${before}..${sha}`);
if (symbols.length === 0) {
  say("This push added no name to grep for, so the container was not checked. Deployment is unverified.");
  process.exit(0);
}
const symbol = symbols[0] ?? "";
// CI going green is the image; the container is a restart behind it.
for (let attempt = 1; attempt <= RESTART_ATTEMPTS; attempt++) {
  const found = await run([
    "ssh",
    ssh,
    `docker exec ${container} sh -c ${JSON.stringify(`grep -rl ${JSON.stringify(symbol)} /app/dist | head -1`)}`,
  ]);
  if (found.ok && found.out) {
    say(`${symbol} is in ${found.out.split("\n")[0]} on ${ssh}:${container}`);
    process.exit(0);
  }
  if (attempt < RESTART_ATTEMPTS) await Bun.sleep(RESTART_WAIT_MS);
}
fail(`CI was green but ${symbol} never appeared in /app/dist. The container is running older code.`);

export {};
