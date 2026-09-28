import { eventEvidenceType } from "./confidence.js";
import { recordFor } from "./record.js";
import { isModelSighting } from "./signals.js";
import type { ClaimType, Event, EvidenceType } from "./types.js";

/**
 * What an event claims happened, as opposed to who should hear about it.
 *
 * `SignalClass` is a routing axis and says so over its own declaration: it answers "does a
 * subscriber to this channel want this message". That makes `launch` a coherent route and an
 * incoherent answer to "what happened" -- a stealth listing, a severe outage, a limit reset and a
 * model that went free all route as `launch` because a reader wants all four now. Reports that
 * grouped by it were reading a delivery decision as a description of the world.
 *
 * This is the description. It has no column: every input is already on the row -- the stream, the
 * kind, the evidence type and the record itself -- so storing it would buy a migration, NULL over
 * all history and a fallback in every reader, in exchange for a value that can be recomputed
 * exactly. It also means it answers for the 8504 events recorded before `signal` was kept, which is
 * the half of history `signalOf` can only guess at.
 *
 * `null` is a real answer. A market pricing a rumour claims nothing about the world -- it says what
 * strangers expect -- and an evidence type this service cannot name claims nothing either.
 */
const BY_EVIDENCE: Partial<Record<EvidenceType, ClaimType>> = {
  api_catalogue: "model_available",
  availability_catalogue: "model_listed",
  arena_roster: "model_sighted",
  open_weights: "weights_published",
  package_release: "software_released",
  github_activity: "repository_activity",
  binary_string: "model_named",
  official_news: "article_published",
  web_diff: "page_changed",
  leaderboard: "rank_changed",
  status_page: "incident_started",
  deprecation: "deprecation_announced",
};

const CATALOGUES = new Set<ClaimType>(["model_available", "model_listed"]);

/**
 * A row whose only moved field is its price sheet. The catalogue still lists the same model, so
 * what happened is a price change and not a listing; `interpretation.ts` decides whether the move
 * is worth telling anyone, which is a separate question from what it was.
 */
function onlyPriceMoved(event: Event): boolean {
  if (event.kind !== "changed") return false;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : {};
  const after: Record<string, unknown> = recordFor(event) ?? {};
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return moved.length > 0 && moved.every((key) => key === "pricing");
}

export function claimType(event: Event): ClaimType | null {
  if (event.stream === "markets") return null;
  if (event.stream === "resets") return "limit_reset";
  // A status page stops carrying an incident when it is over, so the omission is the resolution.
  if (event.stream === "incidents") return event.kind === "removed" ? "incident_resolved" : "incident_started";
  // A repository that names a model id no catalogue has listed is a sighting of the model, not
  // activity on the repository: the same tell as a slug appearing in a client's model list.
  if (isModelSighting(event)) return "model_sighted";
  const claim = BY_EVIDENCE[eventEvidenceType(event)] ?? null;
  if (claim && CATALOGUES.has(claim)) {
    if (event.kind === "removed") return "model_delisted";
    if (onlyPriceMoved(event)) return "price_changed";
  }
  return claim;
}

/**
 * What a story establishes, as opposed to what one of its events said.
 *
 * `events.confidence` is written once, in `store.ts`, and never moves, because an event is
 * immutable: the card that went out carried the strength that was true when it was sent, and
 * rewriting the row would make the archive disagree with the message (`promotion.ts` argues this
 * at length). So the thing that rises is the derived claim, not the evidence under it. Three
 * catalogues listing a model at `observed` do not make any of those three events stronger; they
 * make the story's claim that the model exists stronger, and that is a fact about the story.
 *
 * `existence` -- something by this name is real.
 * `availability` -- a reader can call it today.
 * `identity` -- we know which model these names are, rather than that they are something.
 *
 * A claim only rises. A model leaving a catalogue is evidence it existed, never evidence against
 * it, and `stories.current_status` is where a withdrawal is read.
 */
export type StoryClaim = "existence" | "availability" | "identity";

/** A claim that a delisting supports as readily as a listing: it was there to be withdrawn. */
const EXISTENCE: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "model_available",
  "model_listed",
  "model_delisted",
  "model_sighted",
  "model_named",
  "weights_published",
  "page_changed",
  "rank_changed",
  "price_changed",
  "deprecation_announced",
]);

/** Called today, by the reader, in the catalogue they would call it from. */
const AVAILABILITY: ReadonlySet<ClaimType> = new Set<ClaimType>(["model_available", "model_listed"]);

export function claimsOf(event: Event, knowsIdentity: boolean): StoryClaim[] {
  const claim = claimType(event);
  if (claim === null) return [];
  const claims: StoryClaim[] = [];
  if (EXISTENCE.has(claim)) claims.push("existence");
  if (AVAILABILITY.has(claim) && event.kind !== "removed") claims.push("availability");
  // An identity is claimed by the source naming the model, not by this service recognising it.
  if (knowsIdentity && EXISTENCE.has(claim)) claims.push("identity");
  return claims;
}
