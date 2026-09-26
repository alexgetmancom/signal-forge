import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collection } from "../events/types.js";
import { type FailureKind, SourceError } from "../failure.js";
import { SourceHttpError } from "./http.js";

/**
 * A heavy collector, run in a process of its own so that what it takes dies with it.
 *
 * Nothing this service holds is large: measured on 2026-09-26, six heavy sources run back to back
 * left 1,075 MB resident while holding 8 MB of live heap. The rest is the high-water mark of the
 * allocator, which neither a full collection nor three hours of idling gives back, so the worst
 * moment of a process becomes its floor for as long as it lives -- the average is the peak. A short
 * process has no floor to raise: the same six, each in its own child, left the parent at 173 MB.
 *
 * The cost is 200 to 400 ms of startup per collection, against intervals of half an hour and up.
 */

/** How long a child gets before it is killed. The slowest heavy collector measured 7.9 s. */
const TIMEOUT_MS = 300_000;

/**
 * A failure, crossed between processes without being flattened first.
 *
 * The poller reads more off a failure than its text: a `SourceHttpError` carries the time an
 * upstream asked us to come back, and the status that tells a refused credential from a flaky link.
 * Serialising to a message would silently drop the backoff for every heavy source, so the class is
 * reconstructed on the other side rather than described.
 */
type WireFailure =
  | { as: "http"; message: string; retryAt: string | null; status: number | null; rateLimited: boolean }
  | { as: "source"; kind: FailureKind; message: string; evidence: Record<string, unknown> | null }
  | { as: "other"; name: string; message: string; code: string | null };

type WireAnswer = { ok: true; collection: Collection } | { ok: false; failure: WireFailure };

/** What the child writes down about a failure, in the child. */
export function toWire(error: unknown): WireFailure {
  if (error instanceof SourceHttpError)
    return {
      as: "http",
      message: error.message,
      retryAt: error.retryAt,
      status: error.status,
      rateLimited: error.rateLimited,
    };
  if (error instanceof SourceError)
    return {
      as: "source",
      kind: error.kind,
      message: error.message,
      evidence: error.evidence ? { ...error.evidence } : null,
    };
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return {
    as: "other",
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: typeof code === "string" ? code : null,
  };
}

/** The same failure again in the parent, as the class the poller expects to catch. */
export function fromWire(failure: WireFailure): Error {
  if (failure.as === "http")
    return new SourceHttpError(failure.message, failure.retryAt, failure.status, failure.rateLimited);
  if (failure.as === "source")
    return new SourceError(failure.kind, failure.message, {
      ...(failure.evidence ? { evidence: failure.evidence } : {}),
    });
  // `unexplainedFailure` reads the name and the `code` off whatever it is handed, so both are put
  // back: an error described as "unexpected" that was really ENOTFOUND sends a reader to the wrong
  // place entirely.
  const error = new Error(failure.message);
  error.name = failure.name;
  if (failure.code) Object.assign(error, { code: failure.code });
  return error;
}

/** What the child did, as seen from outside it. */
export type ChildRun = { answer: string | null; code: number | null; timedOut: boolean; stderr: string };

/** The result of one collection, read from a child's answer and raised as the child raised it. */
export function readAnswer(id: string, run: ChildRun): Collection {
  if (run.timedOut)
    throw new SourceError("network", `${id} did not finish within ${Math.round(TIMEOUT_MS / 1000)}s and was stopped`);
  if (run.answer === null) {
    // No answer and a dead child: killed for memory, or a crash before it could write. The last
    // line of its stderr is ours -- the child is this code -- but it is described rather than
    // quoted, because what a runtime prints when it dies is not something to store.
    const how = run.code === null ? "was killed" : `exited with code ${run.code}`;
    throw new SourceError("collector-bug", `${id} ${how} without answering`);
  }
  let parsed: WireAnswer;
  try {
    parsed = JSON.parse(run.answer) as WireAnswer;
  } catch {
    throw new SourceError("collector-bug", `${id} wrote an answer that is not JSON`);
  }
  if (!parsed.ok) throw fromWire(parsed.failure);
  return parsed.collection;
}

/** Spawns the child and waits for it, killing it if it outstays the timeout. */
async function spawn(id: string): Promise<ChildRun> {
  const path = join(tmpdir(), `signal-forge-${id.replaceAll(/[^a-z0-9]+/gi, "-")}-${Bun.nanoseconds()}.json`);
  // The child's own logging goes to stdout, so the answer cannot: it travels through a file the
  // parent names, which keeps the two channels from being spliced together by a stray log line.
  const child = Bun.spawn([process.execPath, "--smol", entry(), id, path], { stdout: "inherit", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    const timedOut = child.killed && code !== 0;
    const file = Bun.file(path);
    const answer = !timedOut && (await file.exists()) ? await file.text() : null;
    return { answer, code, timedOut, stderr };
  } finally {
    clearTimeout(timer);
    try {
      unlinkSync(path);
    } catch {
      // The child may never have written it, and a temporary file left behind is not a failure.
    }
  }
}

/** Where the child lives, beside this module's own compiled form rather than at a guessed path. */
function entry(): string {
  return new URL(import.meta.url.endsWith(".ts") ? "../collectOne.ts" : "../collectOne.js", import.meta.url).pathname;
}

export async function collectInSubprocess(
  id: string,
  run: (id: string) => Promise<ChildRun> = spawn,
): Promise<Collection> {
  return readAnswer(id, await run(id));
}
