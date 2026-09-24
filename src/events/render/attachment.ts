import { slug } from "../../text.js";
import type { Event, RecordData } from "../types.js";
import { webStringChanges } from "./common.js";

/**
 * A card shows the few changes a person can read at a glance. When a page rewrote four hundred
 * strings, the rest used to end at "…and 432 more changes not shown" and were reachable nowhere:
 * the evidence existed in SQLite and no reader could see it. The full list travels with the
 * message as a text file instead.
 */
export type Attachment = { filename: string; content: string };

/** Below this, everything already fits in the card and a file would be ceremony. */
const MIN_CHANGES_TO_ATTACH = 12;
const MAX_ATTACHMENT_BYTES = 1_000_000;

/**
 * The limit is bytes, so it is counted in bytes.
 *
 * `String.slice` counts UTF-16 code units, which is the same number only while the text is ASCII.
 * A page of CJK release notes is three bytes per character and would have gone out at three times
 * the limit the upload accepts; an emoji cut at its limit would also have been cut in half. The cut
 * is taken on the encoded buffer and then walked back to a character boundary.
 */
function withinBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= limit) return text;
  let end = limit;
  // A continuation byte is 10xxxxxx; step back to the start of the character it belongs to.
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function eventAttachment(event: Event): Attachment | null {
  if (event.stream !== "web" || event.kind !== "changed") return null;
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  if (!Array.isArray(before?.strings) || !Array.isArray(after?.strings)) return null;

  const { meaningfulAdded, meaningfulRemoved } = webStringChanges(before.strings, after.strings);
  if (meaningfulAdded.length + meaningfulRemoved.length < MIN_CHANGES_TO_ATTACH) return null;

  const name = String(after.name ?? before.name ?? event.entity_id);
  const header = [
    `${name} — ${event.source}`,
    `Observed ${event.detected_at}`,
    `${meaningfulAdded.length} added, ${meaningfulRemoved.length} removed`,
    "",
  ];
  const body = [
    ...header,
    ...meaningfulAdded.map((line) => `+ ${line}`),
    ...(meaningfulAdded.length && meaningfulRemoved.length ? [""] : []),
    ...meaningfulRemoved.map((line) => `- ${line}`),
    "",
  ].join("\n");
  const content = withinBytes(body, MAX_ATTACHMENT_BYTES);
  return { filename: `${slug(name) || "evidence"}-${event.id}.txt`, content };
}
