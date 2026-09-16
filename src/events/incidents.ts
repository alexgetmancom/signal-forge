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
function resolved(event: Event): boolean {
  const current = stage((event.after_json ? (JSON.parse(event.after_json) as RecordData) : null)?.stage);
  return ENDED.has(current) || event.kind === "removed";
}

/** Why this incident event says nothing to a subscriber, or null when it does. */
export function incidentSilence(event: Event): string | null {
  if (event.stream !== "incidents") return null;
  const impact = impactOf(event);
  if (IGNORED_IMPACT.has(impact)) return `The vendor rated this "${impact || "no impact"}"`;
  if (event.kind !== "changed") return null;
  // An incident is worth one line when it starts and one when it ends, whatever the vendor graded
  // it. The investigating → identified → monitoring walk in between is written for an on-call
  // engineer, not for a reader. Severity used to exempt an incident from this: OpenAI's
  // `01M2KQNE5C42NEZPX6V01NHH5W` was major, so all three of its Statuspage edits reached the
  // public channel in forty-seven minutes, saying the same outage three times.
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  if (resolved(event)) return null;
  return stage(before?.stage) === stage(after?.stage)
    ? "The incident wording changed but its stage did not"
    : "The incident moved between working stages";
}

/** An outage interrupts a reader only when the vendor calls it severe, or when it is finally over. */
export function incidentIsUrgent(event: Event): boolean {
  if (event.stream !== "incidents") return false;
  return SEVERE.has(impactOf(event)) || resolved(event);
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
