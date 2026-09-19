import { canonical } from "./canonical.js";
import { incidentIsUrgent } from "./incidents.js";
import { priceMoveRatio } from "./render/common.js";
import type { Event, RecordData } from "./types.js";

export { vendorOf } from "./vendors.js";

import { signalClass } from "./signals.js";
import { isModelVariant } from "./variants.js";

export function isRoutine(event: Event): boolean {
  if (event.source === "claude-web") return true;
  // An outage is the one thing here that cannot wait for the top of the hour, but only when the
  // vendor itself calls it severe; everything else an incident does travels with the digest.
  if (event.stream === "incidents") return !incidentIsUrgent(event);
  if (event.stream === "leaderboards") {
    // A model debuting in the top ten is told the moment it happens, like the launch it follows.
    if (signalClass(event) === "debut") return false;
    const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
    const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const beforeRank = typeof before?.rank === "number" ? before.rank : null;
    const afterRank = typeof after?.rank === "number" ? after.rank : null;
    const rankChanged = beforeRank !== afterRank;
    // A first-place movement is the one leaderboard event worth seeing immediately. Other board
    // churn stays in the hourly digest, and an unchanged first-place score does not interrupt. A
    // first-place departure is the corresponding immediate follow-up.
    const firstPlaceMovement = event.kind === "changed" && rankChanged && (beforeRank === 1 || afterRank === 1);
    const firstPlaceDeparture = event.kind === "removed" && beforeRank === 1;
    return !(firstPlaceMovement || firstPlaceDeparture);
  }
  if (event.kind !== "changed") return false;
  // A nightly or preview channel moves several times a day and says nothing about a product. The
  // release channels people actually install on stay immediate.
  if (event.stream === "packages" && !["latest", "stable"].includes(event.entity_id)) return true;
  if (!["openrouter", "api-models", "arena"].includes(event.stream)) return false;
  const before = JSON.parse(event.before_json ?? "{}") as Record<string, unknown>;
  const after = JSON.parse(event.after_json ?? "{}") as Record<string, unknown>;
  const important = [
    "name",
    "pricing",
    "context",
    "input",
    "output",
    "parameters",
    "capabilities",
    "selectable",
    "inputTokenLimit",
    "outputTokenLimit",
    "methods",
  ];
  const moved = important.filter((key) => canonical(before[key]) !== canonical(after[key]));
  // Three quarters of everything collected so far was a price moving by fractions of a cent.
  // Nobody reads a price at the moment it changes; they read it when working out a budget, and an
  // hourly "twelve models got cheaper" is that same information without twelve notifications.
  const budgetOnly = ["pricing", "context", "inputTokenLimit", "outputTokenLimit"];
  if (moved.length && !moved.every((key) => budgetOnly.includes(key))) return false;
  // A price that halves is not budget planning, it is the news. The hourly digest exists for the
  // fractions of a cent; a move this size is what a reader would have wanted a message about.
  return !steepPriceMove(before, after, event.source);
}

/** The share of a price a move has to cross to be worth reading before the top of the hour. */
const STEEP_PRICE_MOVE_RATIO = 0.25;

function steepPriceMove(before: Record<string, unknown>, after: Record<string, unknown>, source: string): boolean {
  // A batch tier costing half of the standard one is not a price cut, and a catalogue rewriting a
  // row of tiers at once sent six interruptions in a night saying so.
  if (isModelVariant(String(after.name ?? before.name ?? ""))) return false;
  const from = before.pricing && typeof before.pricing === "object" ? (before.pricing as Record<string, unknown>) : {};
  const to = after.pricing && typeof after.pricing === "object" ? (after.pricing as Record<string, unknown>) : {};
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].some((key) => {
    const ratio = priceMoveRatio(from[key], to[key], source);
    return ratio !== null && ratio >= STEEP_PRICE_MOVE_RATIO;
  });
}
