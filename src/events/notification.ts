import { webStringChanges } from "./render/common.js";
import { renderEvent } from "./render/telegram.js";
import type { Event } from "./types.js";

const TOP_RANK = 5;

function rank(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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

/** An observation can be real evidence but still contain no subscriber-facing change. */
export function hasNotificationContent(event: Event, url: string): boolean {
  if (!worthLeaderboardNotification(event)) return false;
  if (event.kind === "changed" && event.stream === "web") {
    const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
    const after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : null;
    if (Array.isArray(before?.strings) && Array.isArray(after?.strings)) {
      const { meaningfulAdded, meaningfulRemoved } = webStringChanges(before.strings, after.strings);
      return meaningfulAdded.length > 0 || meaningfulRemoved.length > 0;
    }
  }
  if (event.kind !== "changed") return true;
  const body = renderEvent(event, url).split("\n").slice(3, -3).join("").trim();
  return body.length > 0;
}
