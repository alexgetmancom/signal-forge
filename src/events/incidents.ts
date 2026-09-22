import type { Event, RecordData } from "./types.js";

/**
 * Which outages are worth a person's attention.
 *
 * Three and a half days of collection produced thirty-seven incident events: one major, twenty-six
 * minor and ten of no impact at all, including "Delays in customer support responses" posted four
 * separate times as its wording was edited. A reader who is told about every one of those stops
 * reading the ones that matter.
 *
 * The vendors already grade their own incidents, and that grade is the filter. What is left is the
 * shape of an incident's life: Statuspage posts an update every time someone types a sentence, and
 * only two of those transitions are news to somebody who is not on call — it started, and it ended.
 */
const SEVERE = new Set(["major", "critical"]);
const IGNORED_IMPACT = new Set(["none", "maintenance"]);

function record(event: Event): RecordData | null {
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  return after ?? (event.before_json ? (JSON.parse(event.before_json) as RecordData) : null);
}

function impactOf(event: Event): string {
  const value = record(event)?.impact;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function stage(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * True once an incident is over, whichever way the source spells it. `unlisted` is the vendor
 * having stopped publishing it rather than having announced an end, which is the same thing to a
 * reader and the honest word for it on the card.
 */
const ENDED = new Set(["resolved", "completed", "unlisted"]);
export function incidentEnded(event: Event): boolean {
  return event.stream === "incidents" && resolved(event);
}
function resolved(event: Event): boolean {
  const current = stage((event.after_json ? (JSON.parse(event.after_json) as RecordData) : null)?.stage);
  return ENDED.has(current) || event.kind === "removed";
}

/** Why this incident event says nothing to a subscriber, or null when it does. */
export function incidentSilence(event: Event): string | null {
  if (event.stream !== "incidents") return null;
  const impact = impactOf(event);
  if (IGNORED_IMPACT.has(impact)) return `The vendor rated this "${impact || "no impact"}"`;
  if (event.kind === "new") return null;
  /**
   * Only the start of an outage speaks. Everything after it -- the investigating → identified →
   * monitoring walk, the wording edits, and the end -- is written for somebody on call. A reader
   * who was told the service is broken does not need to be interrupted again to be told it is
   * fixed: they find that out by using it. OpenAI's `01M2KQNE5C42NEZPX6V01NHH5W` said the same
   * outage three times in forty-seven minutes on 2026-09-16.
   */
  if (resolved(event)) return "The incident ended, and its start was already reported";
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  return stage(before?.stage) === stage(after?.stage)
    ? "The incident wording changed but its stage did not"
    : "The incident moved between working stages";
}

/**
 * The products the wire's readers pay $20 a month for. "Elevated errors for multiple models" on
 * 2026-09-22 was Anthropic's API, graded major, and reached a room of Codex and Claude subscribers
 * who felt none of it.
 */
const CONSUMER_PRODUCTS = /\b(?:chatgpt|codex|sora|claude\.ai|claude code|claude app|kimi|chat|app)\b/i;

/**
 * Whether the outage touched a subscriber's product. A page that names no component says nothing
 * either way, and the incident's own title is read instead.
 */
export function incidentTouchesSubscribers(event: Event): boolean {
  const components = record(event)?.components;
  const names = Array.isArray(components) ? components.filter((name) => typeof name === "string") : [];
  if (names.length) return names.some((name) => CONSUMER_PRODUCTS.test(name));
  return CONSUMER_PRODUCTS.test(String(record(event)?.name ?? "").replace(/^[^:]+:\s*/, ""));
}

/** An outage interrupts a reader only when the vendor calls it severe and it has just started. */
export function incidentIsUrgent(event: Event): boolean {
  if (event.stream !== "incidents") return false;
  return SEVERE.has(impactOf(event)) && event.kind === "new";
}

/**
 * Whether the vendor itself graded this outage severe.
 *
 * This is the whole reader-facing filter for incidents. The Platform health board already carries
 * every open incident, read straight from the status page, so a feed that also repeats the minor
 * ones says the same thing twice. What a board cannot do is interrupt: it is edited in place and
 * notifies nobody, and a major outage is the one incident worth interrupting for.
 */
export function incidentIsSevere(event: Event): boolean {
  return event.stream === "incidents" && SEVERE.has(impactOf(event));
}
