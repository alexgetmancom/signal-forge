import { parseRecord } from "./recordBody.js";
import type { Event, RecordData } from "./types.js";

/**
 * The normalized record an event carries: the state after the change, or the state before it when
 * the event removed something. Every reader of event evidence goes through here.
 */
export function recordFor(event: Pick<Event, "after_json" | "before_json">): RecordData | null {
  return parseRecord(event.after_json ?? event.before_json);
}
