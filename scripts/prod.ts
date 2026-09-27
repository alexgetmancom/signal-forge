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

function logsOptions(): { since: string; filter: string | undefined; lines: number } | null {
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] ?? "";
    const equals = token.indexOf("=");
    const flag = token.slice(0, equals < 0 ? undefined : equals);
    const value = equals < 0 ? argv[++index] : token.slice(equals + 1);
    if (!LOG_FLAGS.has(flag) || value === undefined || (equals < 0 && value.startsWith("--")) || options.has(flag))
      return null;
    options.set(flag, value);
  }
  const lines = Number(options.get("--lines") ?? "200");
  if (!Number.isSafeInteger(lines) || lines < 1) return null;
  return { since: options.get("--since") ?? "1h", filter: options.get("--grep"), lines };
}

async function printLogs(options: NonNullable<ReturnType<typeof logsOptions>>): Promise<number> {
  // A remote pipeline reports tail's status even when docker failed. Keep the exit status of the
  // docker command itself, and retain only the last matching lines while reading its output.
  const command = `${remote(["docker", "logs", "--since", options.since, container])} 2>&1`;
  const child = Bun.spawn(["ssh", sshTarget, command], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const sshError = new Response(child.stderr).text();
  const selected: string[] = [];
  const recent: string[] = [];
  const keep = (line: string) => {
    recent.push(line);
    if (recent.length > 10) recent.shift();
    if (options.filter === undefined || line.includes(options.filter)) {
      selected.push(line);
      if (selected.length > options.lines) selected.shift();
    }
  };
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      keep(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) keep(pending);
  const code = await child.exited;
  const diagnostic = await sshError;
  if (code !== 0) {
    if (recent.length) process.stderr.write(`${recent.join("\n")}\n`);
    if (diagnostic) process.stderr.write(diagnostic);
  } else {
    if (selected.length) process.stdout.write(`${selected.join("\n")}\n`);
    if (diagnostic) process.stderr.write(diagnostic);
  }
  return code;
}

if (argv[0] === "logs") {
  const options = logsOptions();
  if (!options) {
    console.error(`logs takes ${[...LOG_FLAGS].join(", ")}, each with a value; --lines must be positive`);
    process.exit(1);
  }
  console.error(`prod → ${sshTarget}:${container}`);
  process.exit(await printLogs(options));
} else {
  console.error(`prod → ${sshTarget}:${container}`);
  const command = remote(["docker", "exec", "-i", container, "bun", "dist/src/cli.js", ...argv]);
  const child = Bun.spawn(["ssh", sshTarget, command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}

export {};
