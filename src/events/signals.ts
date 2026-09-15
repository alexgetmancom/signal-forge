import { text } from "../text.js";
import { incidentIsSevere } from "./incidents.js";
import { recordFor } from "./record.js";
import type { Event } from "./types.js";

/**
 * What a reader came for, which is a different question from how solid the evidence is.
 *
 * Confidence says how much the source can be trusted. A signal class says whether a person who
 * subscribed to hear about new things wants this message at all. An unnamed codename on an arena
 * is the weakest evidence in the system and the most interesting thing in it; a first-party
 * retirement date shift is the strongest evidence and the least interesting.
 */
export const SIGNAL_CLASSES = [
  "launch",
  "codename",
  "release",
  "article",
  "evidence",
  "rank",
  "change",
  "incident",
  "reminder",
  "retirement",
] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

/**
 * The class of an event, derived from the same evidence the card is rendered from.
 *
 * `launch`: something a reader can now use, or can no longer use. An announcement, a catalogue
 *   entry appearing or disappearing, a published release.
 * `codename`: something on its way. An arena sighting, an entry listed but not yet selectable, a
 *   new leaderboard key, a retirement notice that names a successor.
 * `release`: software shipped around the models. A mobile or desktop app version, a CLI or SDK
 *   release, an entry in a tool's changelog. Real news to whoever uses that tool and nothing at
 *   all to whoever came for models, so it never interrupts.
 * `article`: what a vendor chose to say. Research, policy, hiring, customer stories, engineering
 *   write-ups. A model becoming usable is observed in the catalogue, not in the newsroom, so a
 *   post is commentary on an event rather than the event.
 * `evidence`: the raw trail for a reader who digs. Documentation and interface diffs, repository
 *   activity, package versions, a retirement notice with no successor named.
 * `change`: a number that moved. Pricing, context, availability flags, edited announcements,
 *   shifting deadlines.
 * `rank`: a place on a scoreboard moved. The model did not change and nobody has to act on it.
 * `incident`: an outage the vendor did not call severe. The Platform health board already shows
 *   every open incident, so this class exists to keep the routine ones off the reader feed while
 *   the board keeps counting them.
 * `reminder`: derived operator work rather than an observation, such as a deadline reminder.
 */
/** The sources that publish prose rather than a changelog. */
/**
 * A blog, as opposed to a changelog. Google's belongs here for the same reason OpenAI's does: two
 * of the two posts it published by 2026-09-15 were a conference promotion and an astronaut
 * interview, and it is also where a Gemini launch would appear. Left out of this set its posts were
 * classed `release`, which is the class reserved for a changelog entry, and the newsroom filter --
 * which reads the class -- never looked at them.
 */
const NEWSROOMS = new Set(["openai-news", "anthropic-news", "huggingface-blog-feed", "google-ai-blog"]);

export function signalClass(event: Event): SignalClass {
  const record = recordFor(event);
  const listedButUnusable = record?.selectable === false;

  if (event.stream === "arena") return "codename";
  if (event.source.startsWith("discovery:")) return "codename";

  /**
   * A place on a board moving is not a number a reader budgets with. Ten of them arrive in one
   * digest message and read as a wall, and the model they are about did not change: `change` is for
   * what a vendor did, `rank` for what a scoreboard did.
   */
  if (event.stream === "leaderboards") return event.kind === "new" ? "codename" : "rank";

  /**
   * A retirement is read by whoever runs the model being retired, and that is a small, attentive
   * audience rather than the public one: the readers who came for what is new do not need a date
   * on a model they never called. A notice that names its successor is the earliest word on the
   * model replacing it, which is the same reason it belongs beside the codenames.
   */
  if (event.stream === "deprecations") {
    if (event.kind !== "new") return "evidence";
    return text(record?.replacement) ? "codename" : "evidence";
  }

  /**
   * A newsroom is not a release feed. Every vendor mixes releases with research, policy and
   * customer stories under one heading, and Anthropic grades nine posts out of ten as
   * "Announcements", so the source cannot be asked which is which. It does not have to be: a model
   * a reader can use appears in the vendor's own catalogue, which is where the launch is observed.
   * The post is what the vendor said about it.
   */
  if (event.stream === "news")
    return NEWSROOMS.has(event.source) ? "article" : event.kind === "new" ? "release" : "change";

  if (event.stream === "apps") return "release";

  // A page appearing on a vendor site before any announcement is the same kind of tell as an
  // unreleased model on an arena. A page that leaves is evidence, not a signal to wake anyone.
  if (event.stream === "pages") return event.kind === "new" ? "codename" : "evidence";

  if (event.stream === "web") return "evidence";
  if (event.stream === "packages") return "evidence";
  // A major outage is the one incident that has to interrupt: it travels with the launches, which
  // is where everything a reader must act on right now already goes. Everything else the vendors
  // grade lower is on the board and nowhere else.
  if (event.stream === "incidents") return incidentIsSevere(event) ? "launch" : "incident";

  /**
   * Limits coming back is the most direct "you can use this now" in the system: nothing was
   * released, but a reader who ran out an hour ago can work again, and only for the next few
   * hours. It reads as a number moving and behaves like a launch, so it travels with the launches.
   *
   * A reset is announced in two steps by the same person — promised, then applied — and both
   * steps are news, so both are launches and both reach the same channel.
   */
  if (event.stream === "resets") return "launch";

  if (event.stream === "github")
    return event.source.endsWith(":releases") && event.kind === "new" ? "release" : "evidence";

  if (["api-models", "openrouter", "weights"].includes(event.stream)) {
    if (event.kind === "new") return listedButUnusable ? "codename" : "launch";
    /**
     * A row leaving a catalogue is not the other half of a launch. Over the week to 2026-09-15 the
     * channel carrying launches spent half its cards on four departures -- a dated preview snapshot,
     * an ancient preview, a 1B checkpoint, a catalogue row -- and every one of them ended something
     * that channel had never been told arrived: zero delivered arrivals, one delivered departure
     * each. Meanwhile the retirement a vendor actually announced went to the quiet room, which is
     * the whole arrangement upside down.
     *
     * It keeps its own class so a room can take the arrivals without the bookkeeping. The evidence
     * is stored either way and reads back through `events` and `stories`.
     */
    if (event.kind === "removed") return "retirement";
    return "change";
  }

  return "change";
}

/**
 * A role mention interrupts a person's day, so it is reserved for the two classes they subscribed
 * for. Numbers moving and raw evidence never ping.
 */
export function pingWorthy(event: Event): boolean {
  // A promised reset is worth reading and not worth interrupting: nothing has come back yet, and
  // the same announcement pings for real when it is applied.
  if (event.stream === "resets" && recordFor(event)?.stage !== "Applied") return false;
  const signal = signalClass(event);
  return signal === "launch" || signal === "codename";
}
