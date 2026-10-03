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
 *
 * Fixing the transport left eight of those 23 standing, because a collection is more than its
 * collector: see `NOT_RAISED_BY_A_COLLECTION` below for the write path and why the scope of the rule
 * is now everything a collection reaches rather than one directory.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

/**
 * The rule stopped at the collector, and a collection does not.
 *
 * Closing the transport hole left eight of the twenty-three `{"name":"Error"}` failures unexplained:
 * `mistral`, `meta-blog`, `mimo`, `polymarket`, `vertex-model-garden`, `huggingface:openai`,
 * `anthropic-model-index` and `discovery:blog-zai` never called `fetch` themselves, so nothing about
 * their reads was wrong. They failed *after* the read, in `saveCollection`: seven guards on the write
 * path checked that an `INSERT ... RETURNING` had returned a row and threw a bare `Error` when it had
 * not, and the poller filed a local write failure as "unexpected error (Error)" with no kind at all.
 *
 * So the scope of the gate is the mistake, not the location of it. `src/sources` was never the rule;
 * "a failure a collection can raise says what kind it is" was. Everything a collection reaches is
 * everything imported, transitively, from `src/events/pipeline.ts` -- which is what `poller.ts` calls
 * once the bytes are in hand, and the only entry a new step would be hung off. Walking imports rather
 * than naming directories is deliberate: a file that joins the write path next month is covered the
 * moment something on it imports the file, which is the same move that puts it there.
 */
const COLLECTION_ENTRY = join(root, "src", "events", "pipeline.ts");

/**
 * Bare `Error`s on the collection path that no collection can raise, each with why it stays bare.
 *
 * Keyed by the sentence rather than the line so that moving code does not silently widen the
 * exemption: a new `throw` in one of these files is still a finding. A write failure never belongs
 * here -- it belongs in `storageFailure`.
 */
const NOT_RAISED_BY_A_COLLECTION: Readonly<Record<string, { why: string; sentences: string[] }>> = {
  "src/config.ts": {
    why: "Configuration is validated once while the process boots, before any source is read.",
    sentences: ["SOLO_PUBLISHER_MCP_URL", "TELEGRAM_BOT_TOKEN is required", "DISCORD_BOT_TOKEN is required"],
  },
  "src/credentials.ts": {
    why: "Closing a credential circuit is an operator's command, not a step of a collection.",
    sentences: ["No open credential circuit"],
  },
  "src/sources/registry.ts": {
    why: "The registry is validated at boot: a bad definition is a mistake in this repository.",
    sentences: [
      "Duplicate source ID",
      "has no label",
      "has no group",
      "has invalid authority",
      "is first-party and names no vendor",
      "has invalid mode",
      "has an invalid interval",
      "has invalid pacing",
      "has conflicting intervals",
    ],
  },
  "src/events/render/story.ts": {
    why: "A story with no events cannot be projected, so rendering one is a bug in the caller rather than a failure of a read.",
    sentences: ["Cannot render an empty story"],
  },
  "src/stories.ts": {
    why: "A group is given its database ID by the upsert immediately above; reaching here without one is the same kind of bug.",
    sentences: ["has no database ID"],
  },
  "src/hypotheses.ts": {
    why: "Bounds on an argument a person typed, reached from the CLI and the reports rather than from a collection.",
    sentences: ["Hypothesis limit must be", "Hypothesis ID must be"],
  },
  "src/lifecycle.ts": {
    why: "Bounds on an argument a person typed, reached from the CLI rather than from a collection.",
    sentences: ["Deadline days must be"],
  },
};

/** Every file the collection path can reach, by following its imports from the entry. */
function collectionPath(entry: string, result = new Set<string>()): Set<string> {
  if (result.has(entry)) return result;
  result.add(entry);
  for (const [, specifier] of readFileSync(entry, "utf8").matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
    const imported = resolve(dirname(entry), (specifier ?? "").replace(/\.js$/, ".ts"));
    if (imported.startsWith(root) && existsSync(imported)) collectionPath(imported, result);
  }
  return result;
}

const onThePath = [...collectionPath(COLLECTION_ENTRY)].sort();
const unkinded: string[] = [];
for (const file of onThePath) {
  const name = relative(root, file);
  const allowed = NOT_RAISED_BY_A_COLLECTION[name]?.sentences ?? [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (!/\bthrow\s+new\s+Error\s*\(/.test(line)) return;
      if (allowed.some((sentence) => line.includes(sentence))) return;
      unkinded.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
}

if (unkinded.length) {
  console.error(
    `A step of a collection threw a bare Error, which the poller files as "unknown" and prints as "unexpected error (Error)":\n${unkinded
      .map((finding) => `- ${finding}`)
      .join(
        "\n",
      )}\nThrow storageFailure(what) from src/failure.ts when a write did not take effect -- that is the "database" kind, which says local storage rather than the upstream -- or SourceError(kind, message) for anything else. If no collection can reach it, add the sentence to NOT_RAISED_BY_A_COLLECTION in this script with why.`,
  );
  process.exit(1);
}

console.log(
  `Failure check passed: no collector in ${scanned} files reaches the network outside http.ts, and none of the ${onThePath.length} files a collection passes through throws a failure without a kind.`,
);
