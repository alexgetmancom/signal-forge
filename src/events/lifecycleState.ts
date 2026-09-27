import { eventEvidenceType } from "./confidence.js";
import type { Event, EvidenceType, LifecycleState } from "./types.js";

/**
 * Where a subject is in its life, which is what `confidence: "shipped"` used to say badly.
 *
 * This is a pure function of the evidence type and the stream, so it gets no column: every input it
 * reads is already stored on the row, and a column would buy a migration, NULL over all history and
 * a fallback in every reader in exchange for nothing. Confidence answers "how well does this hold",
 * this answers "has it come out".
 *
 * `null` is the honest answer rather than a gap. An article, an outage and a leaderboard move say
 * nothing about whether anything is available: a blog post about safety research and a status page
 * incident are not stages of a product's life, and a reader told "announced" under either would be
 * told something no source here established.
 */
const BY_EVIDENCE: Partial<Record<EvidenceType, LifecycleState>> = {
  // The maker's own catalogue lists what can be called today; a reseller's says the same of itself.
  api_catalogue: "available",
  availability_catalogue: "available",
  official_news: "announced",
  // A roster entry is a model a member of the public can use without the maker having said so.
  arena_roster: "previewed",
  // A registry entry is the strongest statement of all that something is out: you can install it.
  package_release: "shipped",
  open_weights: "shipped",
  deprecation: "deprecated",
};

export function lifecycleState(
  event: Pick<Event, "source" | "stream" | "authority" | "evidence_type">,
): LifecycleState | null {
  // Strangers pricing a release that has not happened. The only stream whose subject is a future.
  if (event.stream === "markets") return "rumored";
  // A removal from a deprecation notice is the date arriving, not a second warning about it.
  if (event.stream === "deprecations" && "kind" in event && (event as Event).kind === "removed") return "retired";
  return BY_EVIDENCE[eventEvidenceType(event as Event)] ?? null;
}
