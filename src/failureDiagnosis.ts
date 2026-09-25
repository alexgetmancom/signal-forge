import { isCredentialRejection } from "./credentials.js";
import { CollectionDegradedError } from "./events/store.js";
import type { FailureKind } from "./failure.js";
import { SourceError } from "./failure.js";
import { SourceHttpError } from "./sources/http.js";

/**
 * Whether a `TypeError` came from the transport or from our own code.
 *
 * `fetch` reports every connection failure as a bare `TypeError`, and so does reading a property of
 * something undefined -- which is what a collector does the first time an upstream renames a field.
 * Calling both "network error" sends whoever reads it to the router while the bug sits in the
 * parser, and the source keeps failing for as long as they look in the wrong place.
 *
 * The transport leaves evidence the runtime chose: a `cause` carrying a code, or one of a small set
 * of fixed phrases it raises itself. Neither can quote a credential or a response body, which is
 * why they are the only two things read here. Everything else is ours.
 */
const TRANSPORT_PHRASES = ["fetch failed", "unable to connect", "failed to fetch", "network request failed"];

function transportFailure(error: unknown, code: string | undefined): boolean {
  if (code) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return TRANSPORT_PHRASES.some((phrase) => message.includes(phrase));
}

function runtimeCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  return [error, cause]
    .map((value) => (value && typeof value === "object" ? (value as { code?: unknown }).code : undefined))
    .find((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(value));
}

/** The kind of an error that carries no kind of its own, read off names the runtime chose. */
function inferredKind(error: unknown, code: string | undefined): FailureKind {
  const name = error instanceof Error ? error.name : typeof error;
  // `SQLITE_BUSY` from an operator poll racing the service was reported as a network error on
  // 2026-09-16, which sends whoever reads it to the router instead of to the lock.
  if (name === "ZodError" || name === "SyntaxError") return "schema";
  if (name === "SQLiteError") return "database";
  if (name === "AbortError" || name === "TimeoutError" || code?.startsWith("E")) return "network";
  if (name === "TypeError") return transportFailure(error, code) ? "network" : "collector-bug";
  return "unknown";
}

const KIND_PHRASE: Readonly<Record<FailureKind, string>> = {
  http: "upstream refused",
  "rate-limited": "rate limited",
  credential: "credential refused",
  "bot-protection": "challenged by bot protection",
  schema: "response did not match the schema",
  "missing-content": "the page no longer carries what is read off it",
  empty: "answered with nothing",
  protocol: "the exchange misbehaved",
  network: "network error",
  degraded: "answer refused to protect what is stored",
  database: "local database error",
  "collector-bug": "collector bug",
  unknown: "unexpected error",
};

/**
 * What kind of failure this was, in words that can carry no credential and no response body.
 *
 * The message is withheld because it can quote either. That used to withhold everything: Artificial
 * Analysis failed inside a collection cycle on 2026-09-16 and passed every reproduction outside one,
 * and "network or schema validation error" could not say which half had happened. The class of the
 * error and the transport's own code are names chosen by the runtime, never by the upstream.
 */
export function unexplainedFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = runtimeCode(error);
  return `Collection failed: ${KIND_PHRASE[inferredKind(error, code)]} (${[name, code].filter(Boolean).join(", ")})`;
}

export type Diagnosis = {
  kind: FailureKind;
  /** Safe to store and to print: either written in this repository or built from runtime names. */
  message: string;
  /** Structure worth keeping to answer "which field", with no upstream values in it. */
  evidence: Record<string, unknown> | null;
};

/** How many of a schema error's complaints are worth keeping. The first few name the field. */
const KEPT_ISSUES = 12;
/** A path element can be a key the upstream chose. A field name is short; a payload is not. */
const MAX_PATH_ELEMENT = 40;

type ZodLikeIssue = { path?: unknown; code?: unknown; expected?: unknown };

function issuePath(path: unknown): string {
  if (!Array.isArray(path)) return "";
  return path
    .map((element) => (typeof element === "number" ? "#" : String(element).slice(0, MAX_PATH_ELEMENT)))
    .join(".");
}

/**
 * Evidence for a schema failure: which field, not what was in it.
 *
 * `arena` failed 30 of 178 attempts over three days with nothing recorded but the words "ZodError",
 * and the body of a failed parse is never stored, so there was no way to learn which of its 1,083
 * entries was wrong. Keeping the issue paths answers that without keeping the answer: a path is a
 * list of field names from the schema in this repository, and an array index is reduced to `#`
 * because which of a thousand rows it was tells nobody anything.
 */
function schemaEvidence(error: unknown): Record<string, unknown> | null {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || !issues.length) return null;
  const shapes = new Map<string, number>();
  for (const raw of issues as ZodLikeIssue[]) {
    const key = `${issuePath(raw.path)}|${String(raw.code ?? "?")}|${String(raw.expected ?? "")}`;
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  return {
    issueCount: issues.length,
    issues: [...shapes.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, KEPT_ISSUES)
      .map(([key, count]) => {
        const [path, code, expected] = key.split("|");
        return { path, code, ...(expected ? { expected } : {}), count };
      }),
  };
}

/**
 * Classify a collection failure by the type of the error, never by the shape of its message.
 *
 * Trust is the whole point. A `SourceError` and a `SourceHttpError` are constructed in this
 * repository, so their text is ours and is kept. Everything else is described rather than quoted.
 */
export function classifyFailure(error: unknown): Diagnosis {
  if (error instanceof CollectionDegradedError)
    return {
      kind: "degraded",
      message: error.message,
      evidence: { previousCount: error.previousCount, retainedCount: error.retainedCount },
    };
  if (error instanceof SourceError)
    return { kind: error.kind, message: error.message, evidence: error.evidence ? { ...error.evidence } : null };
  if (error instanceof SourceHttpError) {
    const kind: FailureKind = error.rateLimited
      ? "rate-limited"
      : isCredentialRejection(error.status)
        ? "credential"
        : "http";
    return {
      kind,
      message: error.message,
      evidence: {
        status: error.status,
        rateLimited: error.rateLimited,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      },
    };
  }
  const code = runtimeCode(error);
  const kind = inferredKind(error, code);
  const name = error instanceof Error ? error.name : typeof error;
  return {
    kind,
    message: unexplainedFailure(error),
    evidence:
      kind === "schema"
        ? (schemaEvidence(error) ?? { name, ...(code ? { code } : {}) })
        : { name, ...(code ? { code } : {}) },
  };
}
