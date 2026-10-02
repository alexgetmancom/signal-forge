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

console.log(`Failure check passed: no collector in ${scanned} files throws a bare Error.`);
