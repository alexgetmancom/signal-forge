import { hasNotificationContent } from "../events/notification.js";
import { MAX_DETAIL_LINES, webStringChanges } from "../events/render/common.js";
import { renderEvent } from "../events/render/telegram.js";
import type { Event } from "../events/types.js";

/**
 * A title a reader cannot read. Moonshot's status page is Chinese only: "搜索请求出现大量报错" reached
 * the public wire on 2026-09-19 as a severe outage nobody in the room could read. However short the
 * record, the sentence under it is then the only English the card carries.
 */
const UNREADABLE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

export function needsSummary(event: Event, url: string): boolean {
  if (event.kind === "removed") return false;
  if (UNREADABLE.test(eventTitle(event))) return true;
  if (!hasNotificationContent(event)) return false;
  const material = (event.before_json?.length ?? 0) + (event.after_json?.length ?? 0);
  if (material > 1_200) return true;
  const body = renderEvent(event, url).split("\n").slice(3, -3);
  return body.length >= MAX_DETAIL_LINES || body.join("\n").length > 700;
}

function webStrings(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { strings?: unknown };
    return Array.isArray(parsed.strings) ? parsed.strings : [];
  } catch {
    return [];
  }
}

/**
 * What the summariser is asked to read, which is not always what was stored.
 *
 * An interface diff is stored as two whole string tables: claude.ai's was 58 KB on 2026-09-29, and
 * the prompt is cut at 6,000 characters, so DeepSeek was handed the first tenth of PREVIOUS and
 * never reached CURRENT at all. It answered "unclear" twice and the card fell back to counting
 * lines -- "64 lines added, 44 removed" over a change that had added "You're part of an early
 * access test". The difference between the two tables is a hundred lines and is the whole of what
 * happened, so it is what goes.
 *
 * Everything else leads with CURRENT for the same reason: when the cut falls somewhere, it should
 * fall on the state that is being left rather than on the one being described.
 */
export function summaryMaterial(event: Event): string {
  if (event.stream === "web") {
    const { added, removed } = webStringChanges(webStrings(event.before_json), webStrings(event.after_json));
    if (added.length || removed.length)
      return [
        added.length ? `ADDED:\n${added.map((value) => `+ ${value}`).join("\n")}` : "",
        removed.length ? `REMOVED:\n${removed.map((value) => `- ${value}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
  }
  return [`CURRENT:\n${event.after_json ?? ""}`, event.before_json ? `PREVIOUS:\n${event.before_json}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

export function eventTitle(event: Event): string {
  try {
    const current = JSON.parse(event.after_json ?? event.before_json ?? "{}") as unknown;
    if (current !== null && typeof current === "object" && typeof (current as { name?: unknown }).name === "string")
      return (current as { name: string }).name;
  } catch {
    // The event was already persisted; malformed evidence should not stop delivery.
  }
  return event.entity_id;
}
