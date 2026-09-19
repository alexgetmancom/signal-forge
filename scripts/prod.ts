/**
 * The operator CLI, run against production instead of this checkout.
 *
 * The local database is a stale copy at best; every question about what the service saw is a
 * question about the one on the host. This forwards the command over ssh into the running
 * container, where `dist/src/cli.js` is the same registry `bun src/cli.ts` dispatches locally.
 *
 *   bun run prod news            what reached readers in the last 24h
 *   bun run prod news 6 launch   launches in the last 6h
 *   bun run prod logs [--since 1h] [--grep TEXT] [--lines N]
 *
 * Target: SIGNAL_FORGE_SSH (default `vm106`), container SIGNAL_FORGE_CONTAINER
 * (default `signal-forge-app-1`). stderr carries the banner so stdout stays JSON.
 */
const sshTarget = process.env.SIGNAL_FORGE_SSH?.trim() || "vm106";
const container = process.env.SIGNAL_FORGE_CONTAINER?.trim() || "signal-forge-app-1";
const argv = process.argv.slice(2);
if (argv.length === 0) argv.push("help");

const LOG_FLAGS = new Set(["--since", "--grep", "--lines"]);

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
const remote = (parts: readonly string[]): string => parts.map(quote).join(" ");

function logsCommand(): string | null {
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (!LOG_FLAGS.has(flag) || value === undefined) return null;
    options.set(flag, value);
  }
  const filter = options.get("--grep");
  return [
    remote(["docker", "logs", "--since", options.get("--since") ?? "1h", container]),
    "2>&1",
    ...(filter === undefined ? [] : ["|", remote(["grep", "-F", "--", filter])]),
    "|",
    remote(["tail", "-n", options.get("--lines") ?? "200"]),
  ].join(" ");
}

let command: string;
if (argv[0] === "logs") {
  const built = logsCommand();
  if (!built) {
    console.error(`logs takes ${[...LOG_FLAGS].join(", ")}, each with a value`);
    process.exit(1);
  }
  command = built;
} else {
  command = remote(["docker", "exec", "-i", container, "bun", "dist/src/cli.js", ...argv]);
}

console.error(`prod → ${sshTarget}:${container}`);
const child = Bun.spawn(["ssh", sshTarget, command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);

export {};
