/**
 * The production MCP surface, as a local stdio server an agent can launch.
 *
 * The service answers MCP on `/api/mcp`, published on the host's LAN address (compose binds
 * SIGNAL_FORGE_BIND_ADDRESS, not loopback). This opens one ssh
 * tunnel to it and forwards each JSON-RPC line from stdin, so every read-only operation marked
 * `agent: true` is a native tool against the production database -- never the local copy.
 *
 * The token is `MCP_TOKEN` from this checkout's `.env`, beside every other secret; it is the same
 * value production holds. Target: SIGNAL_FORGE_SSH (default `vm106`).
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const env = await Bun.file(`${root}/.env`)
  .text()
  .catch(() => "");
const token = (process.env.MCP_TOKEN ?? env.match(/^MCP_TOKEN=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) {
  process.stderr.write("MCP_TOKEN is missing from .env; it must match production's\n");
  process.exit(1);
}
const sshTarget = process.env.SIGNAL_FORGE_SSH?.trim() || "vm106";
const remotePort = process.env.SIGNAL_FORGE_REMOTE_PORT?.trim() || "18081";
// The address the port is published on is the host's own, which is what ssh resolves the alias to.
const resolved = Bun.spawnSync(["ssh", "-G", sshTarget]).stdout.toString();
const remoteHost =
  process.env.SIGNAL_FORGE_REMOTE_HOST?.trim() || resolved.match(/^hostname (\S+)$/m)?.[1] || "127.0.0.1";

const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const localPort = probe.port;
probe.stop(true);

const tunnel = Bun.spawn(
  [
    "ssh",
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    // A shared master would take the forward and let this client exit at once, which reads as a
    // closed tunnel; this process owns its own connection and ends it on exit.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-L",
    `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
    sshTarget,
  ],
  { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
);
let closing = false;
const close = () => {
  closing = true;
  tunnel.kill();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
tunnel.exited.then((code) => {
  if (closing) return;
  process.stderr.write(`ssh tunnel to ${sshTarget} closed (${code})\n`);
  process.exit(1);
});

const endpoint = `http://127.0.0.1:${localPort}/api/mcp`;
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${localPort}/healthz`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`no answer through the tunnel to ${sshTarget}`);
}
const opened = ready();

async function forward(line: string): Promise<void> {
  let id: unknown = null;
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null;
    await opened;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: line,
    });
    if (response.status === 202) return;
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    process.stdout.write(`${text}\n`);
  } catch (error) {
    if (id === null) return;
    const message = error instanceof Error ? error.message : "forwarding failed";
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) await forward(line);
    newline = buffer.indexOf("\n");
  }
}
close();
