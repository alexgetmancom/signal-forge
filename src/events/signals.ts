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
 * `launch`: something a reader can call now, or an outage the vendor graded severe that has just
 *   started. A row appearing in the vendor's own API catalogue.
 * `retirement`: the vendor's own word that a model or feature is going away, which is the one
 *   changelog entry a reader has to act on by a date.
 * `codename`: something on its way. An arena sighting, an entry listed but not yet selectable, a
 *   reseller listing, weights published to a registry, a new leaderboard key, a retirement notice
 *   that names a successor.
 * `release`: software shipped around the models. A mobile or desktop app version, a CLI or SDK
 *   build, an entry in a tool's changelog. Real news to whoever uses that tool and nothing at all to
 *   whoever came for models, so it never interrupts.
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
/**
 * A blog, as opposed to a changelog. Google's belongs here for the same reason OpenAI's does: two
 * of the two posts it published by 2026-09-15 were a conference promotion and an astronaut
 * interview, and it is also where a Gemini launch would appear. Left out of this set its posts were
 * classed `release`, which is the class reserved for a changelog entry, and the newsroom filter --
 * which reads the class -- never looked at them.
 */
const NEWSROOMS = new Set(["openai-news", "anthropic-news", "huggingface-blog-feed", "google-ai-blog"]);

/**
 * Watched sites whose new pages are not the tell a product page is.
 *
 * A page appearing on a vendor's product site before any announcement is a sighting. A help-centre
 * article is not: "set up Salesforce in Claude" and "let team members run smart reports" reached
 * the invited room as sightings on 2026-09-15, and a reader who came to hear about models cannot
 * do anything with either. A developer blog is a blog, and its posts are what the vendor said.
 */
const HELP_CENTRES = new Set(["pages:claude-support"]);
const PAGE_BLOGS = new Set(["pages:google-devs"]);

/**
 * A changelog entry that says a model or a feature is going away.
 *
 * This is the one thing in a vendor's release notes a reader has to act on by a date, and it
 * arrives in the same feed as "added five request headers". Matched on the vendor's own words
 * because the feed carries no field for it, which is why a feature is caught as well as a model:
 * "we're retiring automatic switching from Instant to Thinking" changes what a ChatGPT subscriber
 * gets as surely as a model leaving the picker does.
 */
const RETIREMENT_WORDS = /\b(retire[sd]?|retirement|retiring|deprecat\w*|sunset\w*|end of life|discontinu\w*)\b/i;

export function signalClass(event: Event): SignalClass {
  const record = recordFor(event);
  const listedButUnusable = record?.selectable === false;

  // An arena roster is rewritten in bulk: one collection on 2026-09-15 withdrew 193 entries at
  // once and every one of them was classed as a sighting, which put sixteen messages carrying ten
  // to twenty-one cards each into the invited room inside eleven seconds. A name leaving an arena
  // ends nothing a reader was told had started -- most of those names were never delivered at all
  // -- and it is the same shape as a page that disappears, so it takes the same class.
  if (event.stream === "arena") return event.kind === "new" ? "codename" : "evidence";
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
  if (event.stream === "news") {
    if (NEWSROOMS.has(event.source)) return "article";
    if (event.kind !== "new") return "change";
    /**
     * A record carrying a version is a tool shipping a build: Claude Code 2.1.271, 2.1.272 and
     * 2.1.273 landed in the invited room inside a day, and nobody there is subscribed to patch
     * notes. A dated entry with no version is the vendor saying something, and the only thing it
     * says that a reader must act on by a date is that a model is going away.
     */
    if (text(record?.version)) return "release";
    return RETIREMENT_WORDS.test(`${text(record?.name)} ${text(record?.summary)} ${text(record?.description)}`)
      ? "retirement"
      : "release";
  }

  if (event.stream === "apps") return "release";

  // A page appearing on a vendor site before any announcement is the same kind of tell as an
  // unreleased model on an arena. A page that leaves is evidence, not a signal to wake anyone.
  if (event.stream === "pages") {
    if (HELP_CENTRES.has(event.source)) return "evidence";
    if (PAGE_BLOGS.has(event.source)) return "article";
    return event.kind === "new" ? "codename" : "evidence";
  }

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
    /**
     * A reseller listing a model is not the vendor shipping it. `z-ai/glm-5.2:free` appeared on
     * OpenRouter and was delivered to the public channel as a launch, worded as though Z.ai had
     * announced something; Z.ai had not. An aggregator is the earliest sight of a model and the
     * weakest word on whether it exists, which is the definition of a codename. The vendor's own
     * catalogue and its own weights repository still launch, and a sighting that the vendor later
     * confirms reaches the public channel through the promotion path that already exists.
     */
    if (event.kind === "new") {
      /**
       * Weights in a registry are the earliest word on a model and the furthest from a reader
       * using one. Intern-S2-397B, Atria-Dawn-Preview and Atria-Dawn-Preview-Ascend-w8a8 all
       * reached the public channel as launches over two days: three separate repositories, none
       * of them callable without renting the hardware to serve it. A launch is a model somebody
       * can call, which is a row in an API catalogue.
       */
      if (event.stream === "weights") return "codename";
      if (listedButUnusable || event.authority === "third_party") return "codename";
      return "launch";
    }
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
    // A row leaving a catalogue is not the vendor announcing anything: over the week to
    // 2026-09-15 the launch channel spent half its cards on four departures, each ending
    // something it had never been told arrived. `retirement` is now the vendor's own word for a
    // model going away, which is the thing a reader has to act on, so a silent withdrawal takes
    // the class for a trail nobody has to read.
    if (event.kind === "removed") return "evidence";
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
