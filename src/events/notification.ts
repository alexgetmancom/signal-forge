import { renderEvent } from "./render/telegram.js";
import type { Event } from "./types.js";

/** A changed observation can be real evidence but still contain no subscriber-facing change. */
export function hasNotificationContent(event: Event, url: string): boolean {
  const body = renderEvent(event, url, undefined, "telegram").split("\n").slice(3, -3).join("").trim();
  return body.length > 0;
}
