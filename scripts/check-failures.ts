/**
 * A collector says what kind of failure it had, by type, or it says nothing at all.
 *
 * AGENTS.md states the rule in prose: a failure's sentence is trusted because of its type, so a
 * collector throws `SourceError(kind, message)` and a bare `Error` is described instead of quoted. A
 * rule in prose lasted exactly until it was measured: on 2026-10-02 ninety-seven of the hundred and
 * six `throw new Error` in `src/sources` were failures of a read, filed as `unknown` with the
 * sentence thrown away, so a page that changed layout told whoever read the board "unexpected
 * error (Error)". They are all typed now, and this is what keeps them that way.
 *
 * `registry.ts` is the one place a bare `Error` is right: it validates the registry while the service
 * boots, which is a mistake in this repository and not a failure of a read.
 *
 * Typing every `throw` closed one half of the hole and left the other open, because a collector does
 * not have to throw an untyped error to report one: it can let somebody else's through. Fourteen
 * collectors called `request` -- the injected `fetch` -- directly instead of going through
 * `src/sources/http.ts`, so a connection that dropped arrived as a bare `TypeError` nobody wrote,
 * was filed as `unknown`, and was stored as `{"name":"Error"}`: 23 of those over the seven days to
 * 2026-10-03 across 15 sources. The same call also skipped the two retries in `http.ts`, which exist
 * because every Anthropic and OpenAI host failed its TLS handshake for seven minutes and recovered
 * untouched -- so the direct call turned a blip into a failed source as well as losing the sentence.
 *
 * Both halves are one rule: in `src/sources` the network is reached through `fetchText` or
 * `fetchResponse` and nowhere else. That is checked here rather than left to review, because a
 * collector added next month looks exactly like the fourteen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sources = join(root, "src", "sources");
/** Files where a bare `Error` is a mistake in the code rather than a failed read, with why. */
const NOT_A_READ = new Set(["registry.ts"]);

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

const findings: string[] = [];
let scanned = 0;
for (const file of walk(sources)) {
  if (NOT_A_READ.has(relative(sources, file))) continue;
  scanned += 1;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (/\bthrow\s+new\s+Error\s*\(/.test(line))
        findings.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
}

/**
 * Where the network may be reached directly. `http.ts` is the implementation of the rule; nothing
 * else in `src/sources` has a reason, and a collector with a new one adds it here with that reason
 * rather than quietly calling `request`.
 */
const MAY_CALL_THE_NETWORK = new Set(["http.ts"]);
/** An injected `fetch`, or the global, being called rather than passed on. */
const DIRECT_CALL = /(?<![\w.$])(?:request|fetch)\s*\(/;

const direct: string[] = [];
for (const file of walk(sources)) {
  if (MAY_CALL_THE_NETWORK.has(relative(sources, file))) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (DIRECT_CALL.test(line)) direct.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
}

if (direct.length) {
  console.error(
    `A collector reached the network without the retries or the failure kind that go with it:\n${direct
      .map((finding) => `- ${finding}`)
      .join(
        "\n",
      )}\nCall fetchText(url, headers, request) for a body, or fetchResponse(url, init, request) when the response itself is read -- a streamed tarball, a posted body, a status. Both retry the outages that heal by themselves and throw SourceError("network", ...) for the ones that do not; passing \`request\` straight to fetch loses both.`,
  );
  process.exit(1);
}

if (findings.length) {
  console.error(
    `A collector threw a bare Error, which is filed as "unknown" and whose sentence is not kept:\n${findings
      .map((finding) => `- ${finding}`)
      .join(
        "\n",
      )}\nThrow SourceError(kind, message) from src/failure.ts, or httpFailure(message, status) for a response that was not ok. The kinds are listed there.`,
  );
  process.exit(1);
}

console.log(
  `Failure check passed: no collector in ${scanned} files throws a bare Error or reaches the network outside http.ts.`,
);
