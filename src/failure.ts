/**
 * A failure that says what kind it is, instead of a message somebody has to recognise.
 *
 * The poller has to decide whether a collector's error text is safe to store in `sources.last_error`,
 * which `issues` prints. Until now it decided with a regular expression over the message:
 *
 *     /^(Source |Public page |GitHub |Anthropic |Gemini |Invalid RSS|.*: empty collection|...)/
 *
 * That fails in both directions. A collector that words a new failure differently loses its
 * diagnosis and is filed as "unexpected error", so the one line that would have explained the
 * outage is replaced by the fact that there was one. And any message that happens to begin with an
 * allowed word is trusted whatever follows it, so `throw new Error("Source returned " + body)`
 * publishes an upstream response -- possibly a signed URL -- to whoever reads the report.
 *
 * A kind carried on the error fixes both. Trust follows from the type, so a collector declares its
 * own diagnosis and gets to keep it; and a message is only trusted because it was written here,
 * never because of the shape of its first word. Everything unconverted still falls through to
 * `unexplainedFailure`, which is what it did before.
 */

/** What went wrong, in the terms somebody deciding what to do about it would use. */
export type FailureKind =
  /** The upstream answered, refusing. */
  | "http"
  /** The upstream asked us to come back later and said when. */
  | "rate-limited"
  /** A credential was refused: asking again will not help until it is replaced. */
  | "credential"
  /** A challenge page rather than the document: the answer is to ask less often. */
  | "bot-protection"
  /** The answer arrived and did not have the shape it is read with. */
  | "schema"
  /** The page or feed still loads and no longer carries what is read off it. */
  | "missing-content"
  /** The answer was well formed and held nothing. */
  | "empty"
  /** The exchange itself misbehaved: a redirect with no target, a body over the limit. */
  | "protocol"
  /** The answer never arrived. */
  | "network"
  /** This service refused the answer to protect what is already stored. */
  | "degraded"
  /** Local storage, not the upstream. */
  | "database"
  /** The collector threw where it should have returned. */
  | "collector-bug"
  | "unknown";

/**
 * An error whose message is safe to show, because it was written here.
 *
 * Interpolating an upstream value into one of these puts that value in front of a reader. A count,
 * a status or a field name from our own schema is fine; a response body, a URL or a header is not.
 */
export class SourceError extends Error {
  readonly kind: FailureKind;
  /** Structure for `source_failure_evidence`: field names and counts, never upstream values. */
  readonly evidence: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: FailureKind,
    message: string,
    options: { cause?: unknown; evidence?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SourceError";
    this.kind = kind;
    this.evidence = options.evidence;
  }
}
