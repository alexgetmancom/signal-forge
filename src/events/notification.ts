import { canonical } from "./canonical.js";
import { incidentSilence } from "./incidents.js";
import { MIN_PRICE_CHANGE_RATIO, priceMoveRatio, significantPriceChange, webStringChanges } from "./render/common.js";
import { eventFacts } from "./render/facts.js";
import type { Event } from "./types.js";

const TOP_RANK = 5;
const TOKEN_LIMIT_KEYS = new Set(["context", "inputTokenLimit", "outputTokenLimit"]);

function rank(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function significantTokenLimitChange(before: unknown, after: unknown): boolean {
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return true;
  const delta = Math.abs(from - to);
  return delta >= 131_072 || delta / Math.max(from, to) >= 0.5;
}

/** Retain every leaderboard event, but keep low-value rank churn out of subscriber notifications. */
function worthLeaderboardNotification(event: Event): boolean {
  if (event.stream !== "leaderboards") return true;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
  const beforeRank = rank(before?.rank);
  const afterRank = rank(after?.rank);
  if (event.kind === "new") return afterRank !== null && afterRank <= TOP_RANK;
  if (event.kind === "removed") return beforeRank !== null && beforeRank <= TOP_RANK;
  if (beforeRank === null || afterRank === null)
    return (beforeRank !== null && beforeRank <= TOP_RANK) || (afterRank !== null && afterRank <= TOP_RANK);
  return beforeRank <= TOP_RANK || afterRank <= TOP_RANK || Math.abs(beforeRank - afterRank) >= 3;
}

/**
 * Why an event says nothing to a subscriber, in the words an operator needs, or null when it does
 * speak. Every quiet event has a reason; before this it had only silence, and answering "why did
 * the hourly digest stay empty?" meant replaying events by hand against the thresholds.
 */
export function notificationBlock(event: Event): string | null {
  if (event.stream === "incidents") return incidentSilence(event);
  if (!worthLeaderboardNotification(event)) return `Leaderboard movement outside the top ${TOP_RANK}`;
  if (event.stream === "packages" && !["latest", "stable"].includes(event.entity_id.toLowerCase()))
    return `Package tag "${event.entity_id}" is not a release channel`;
  if (event.kind === "changed" && event.stream === "web") {
    const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
    const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
    if (Array.isArray(before?.strings) && Array.isArray(after?.strings)) {
      const { meaningfulAdded, meaningfulRemoved } = webStringChanges(before.strings, after.strings);
      return meaningfulAdded.length || meaningfulRemoved.length ? null : "The page changed only boilerplate";
    }
  }
  if (event.kind !== "changed") return null;
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : {};
  const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => canonical(before[key]) !== canonical(after[key]),
  );
  const subscriberChanges = changed.filter((key) => !["updated", "published", "created", "parameters"].includes(key));
  if (!subscriberChanges.length) return "Only bookkeeping fields moved";
  if (subscriberChanges.every((key) => key === "pricing")) {
    const oldPrices =
      before.pricing && typeof before.pricing === "object" ? (before.pricing as Record<string, unknown>) : {};
    const newPrices =
      after.pricing && typeof after.pricing === "object" ? (after.pricing as Record<string, unknown>) : {};
    const priceKeys = [...new Set([...Object.keys(oldPrices), ...Object.keys(newPrices)])].filter(
      (key) => canonical(oldPrices[key]) !== canonical(newPrices[key]),
    );
    if (!priceKeys.some((key) => significantPriceChange(oldPrices[key], newPrices[key], event.source))) {
      const largest = priceKeys
        .map((key) => priceMoveRatio(oldPrices[key], newPrices[key], event.source))
        .filter((ratio): ratio is number => ratio !== null)
        .reduce((most, ratio) => Math.max(most, ratio), 0);
      return `Price moved ${(largest * 100).toFixed(1)}%, under the ${MIN_PRICE_CHANGE_RATIO * 100}% threshold`;
    }
  }
  if (
    subscriberChanges.every((key) => TOKEN_LIMIT_KEYS.has(key)) &&
    !subscriberChanges.some((key) => significantTokenLimitChange(before[key], after[key]))
  )
    return "Token limit moved too little to matter";
  return eventFacts(event).join("").trim().length > 0 ? null : "Nothing left to show once noise fields are dropped";
}

/** An observation can be real evidence but still contain no subscriber-facing change. */
export function hasNotificationContent(event: Event): boolean {
  return notificationBlock(event) === null;
}
