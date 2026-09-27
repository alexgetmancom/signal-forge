import { hasNotificationContent } from "../events/notification.js";
import { MAX_DETAIL_LINES } from "../events/render/common.js";
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
