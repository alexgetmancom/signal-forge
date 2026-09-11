import type { Event, RecordData } from "./types.js";

/**
 * What a reader came for, which is a different question from how solid the evidence is.
 *
 * Confidence says how much the source can be trusted. A signal class says whether a person who
 * subscribed to hear about new things wants this message at all. An unnamed codename on an arena
 * is the weakest evidence in the system and the most interesting thing in it; a first-party
 * retirement date shift is the strongest evidence and the least interesting.
 */
export const SIGNAL_CLASSES = ["launch", "codename", "evidence", "change", "reminder"] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export function isSignalClass(value: string): value is SignalClass {
  return (SIGNAL_CLASSES as readonly string[]).includes(value);
}

function recordFor(event: Event): RecordData | null {
  const raw = event.after_json ?? event.before_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecordData;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The class of an event, derived from the same evidence the card is rendered from.
 *
 * `launch`: something a reader can now use, or can no longer use. An announcement, a catalogue
 *   entry appearing or disappearing, a published release.
 * `codename`: something on its way. An arena sighting, an entry listed but not yet selectable, a
 *   new leaderboard key, a retirement notice that names a successor.
 * `evidence`: the raw trail for a reader who digs. Documentation and interface diffs, repository
 *   activity, package versions, a retirement notice with no successor named.
 * `change`: a number that moved. Pricing, context, ranks, availability flags, edited
 *   announcements, incident updates, shifting deadlines.
 * `reminder`: derived operator work rather than an observation, such as a deadline reminder.
 */
export function signalClass(event: Event): SignalClass {
  const record = recordFor(event);
  const listedButUnusable = record?.selectable === false;

  if (event.stream === "arena") return "codename";
  if (event.source.startsWith("discovery:")) return "codename";

  if (event.stream === "leaderboards") return event.kind === "new" ? "codename" : "change";

  if (event.stream === "deprecations") {
    if (event.kind !== "new") return "change";
    return text(record?.replacement) ? "codename" : "evidence";
  }

  if (event.stream === "news") return event.kind === "new" ? "launch" : "change";

  if (event.stream === "web") return "evidence";
  if (event.stream === "packages") return "evidence";
  if (event.stream === "incidents") return "change";

  if (event.stream === "github")
    return event.source.endsWith(":releases") && event.kind === "new" ? "launch" : "evidence";

  if (["api-models", "openrouter", "weights"].includes(event.stream)) {
    if (event.kind === "new") return listedButUnusable ? "codename" : "launch";
    if (event.kind === "removed") return "launch";
    return "change";
  }

  return "change";
}

/**
 * A role mention interrupts a person's day, so it is reserved for the two classes they subscribed
 * for. Numbers moving and raw evidence never ping.
 */
export function pingWorthy(event: Event): boolean {
  const signal = signalClass(event);
  return signal === "launch" || signal === "codename";
}
