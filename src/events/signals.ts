import { text } from "../text.js";
import { incidentIsSevere } from "./incidents.js";
import { recordFor } from "./record.js";
import type { Event } from "./types.js";
import { vendorOfName } from "./vendors.js";
import { meaningfulWebString, tellingWebString } from "./web.js";

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
const NEWSROOMS = new Set([
  "openai-news",
  "anthropic-news",
  "huggingface-blog-feed",
  "google-ai-blog",
  "deepmind-blog",
  "hackernews",
]);

/**
 * A newsroom post that announces a model is the launch as its maker tells it. "Introducing Gemini
 * 3.8 Live and 3.8 Live Extended Thinking" on 2026-09-15 was classed an article and reached nobody,
 * in a week when the public channel carried two models. The title has to say it is an arrival and
 * name a maker's model; a customer story naming GPT is neither.
 */
const ANNOUNCES =
  /\b(introducing|announcing|meet|launch(?:es|ing)?|now available|available (?:now|today)|releas(?:e|es|ing))\b/i;
const NAMES_A_MODEL =
  /\b(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|gemma|grok|codex|llama|qwen|deepseek|kimi|glm|mistral|minimax)[\s-]?\d/i;

/**
 * The changelogs of the tools and APIs the public channel's readers work in. A version of an SDK or
 * a vendor's hardware feed is a build, not something a Claude Code or Codex user changes their day
 * for, and stays evidence.
 */
const TOOL_CHANGELOGS = new Set([
  "claude-code-changelog",
  "openai-codex-changelog",
  "cursor-changelog",
  "kimi-code-changelog",
  "openai-chatgpt-release-notes",
  "openai-api-changelog",
  "gemini-api-changelog",
  "xai-release-notes",
  "mistral-release-notes",
  "deepseek-updates",
]);

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

/**
 * The maker whose own models an API catalogue sells. A catalogue absent here sells other makers'
 * models -- Groq, Cerebras, the Vercel gateway -- and never launches anything itself.
 */
const CATALOGUE_MAKER: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  xai: "xAI",
  mistral: "Mistral",
  moonshot: "Moonshot",
  kimi: "Moonshot",
  minimax: "MiniMax",
  zai: "Z.ai",
  "deepseek-api": "DeepSeek",
  "deepseek-pricing": "DeepSeek",
  dashscope: "Qwen",
  mimo: "Xiaomi",
  poolside: "Poolside",
};

/**
 * An entry that was listed but could not be picked, and now can. On an arena this is a model moving
 * from private testing to the public picker; in a catalogue it is the moment a listed model starts
 * answering. Six arena entries made that move in the week to 2026-09-10 and each was delivered
 * nowhere, as raw evidence.
 */
function becameSelectable(event: Event): boolean {
  if (event.kind !== "changed" || !event.before_json || !event.after_json) return false;
  const before = JSON.parse(event.before_json) as { selectable?: unknown };
  const after = JSON.parse(event.after_json) as { selectable?: unknown };
  return before.selectable === false && after.selectable === true;
}

/** True when a catalogue arrival is a platform listing somebody else's model, not its maker shipping it. */
export function listsAnotherMakersModel(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const owner = CATALOGUE_MAKER[event.source];
  if (!owner) return true;
  const record = recordFor(event);
  const named = vendorOfName(`${text(record?.id) || event.entity_id} ${text(record?.name)}`);
  return named !== "Unknown" && named !== owner;
}

export function signalClass(event: Event): SignalClass {
  const record = recordFor(event);
  const listedButUnusable = record?.selectable === false;

  // A name leaving an arena ends nothing a reader was told had started, and it is the same shape as
  // a page that disappears, so it takes the same class. On 2026-09-15 193 of them reached the
  // invited room as sightings in sixteen messages; the arena had served a partial roster, and every
  // one of the 193 was back five minutes later under the same id.
  if (event.stream === "arena") return event.kind === "new" || becameSelectable(event) ? "codename" : "evidence";
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
    if (NEWSROOMS.has(event.source)) {
      const title = text(record?.name) ?? "";
      return event.kind === "new" && ANNOUNCES.test(title) && NAMES_A_MODEL.test(title) ? "launch" : "article";
    }
    if (event.kind !== "new") return "change";
    /**
     * A record carrying a version is a tool shipping a build: Claude Code 2.1.271, 2.1.272 and
     * 2.1.273 landed in the invited room inside a day, and nobody there is subscribed to patch
     * notes. A dated entry with no version is the vendor saying something, and the only thing it
     * says that a reader must act on by a date is that a model is going away.
     */
    if (
      !text(record?.version) &&
      RETIREMENT_WORDS.test(`${text(record?.name)} ${text(record?.summary)} ${text(record?.description)}`)
    )
      return "retirement";
    return TOOL_CHANGELOGS.has(event.source) ? "release" : "evidence";
  }

  // An app build is a version number and store copy; nothing here reads what changed in it yet.
  if (event.stream === "apps") return "evidence";

  // A page appearing on a vendor site before any announcement is the same kind of tell as an
  // unreleased model on an arena. A page that leaves is evidence, not a signal to wake anyone.
  if (event.stream === "pages") {
    if (HELP_CENTRES.has(event.source)) return "evidence";
    if (PAGE_BLOGS.has(event.source)) return "article";
    return event.kind === "new" ? "codename" : "evidence";
  }

  // An interface that starts naming a versioned model or a preview is a sighting; the rest of its
  // copy edits are a trail.
  if (event.stream === "web") {
    const before = event.before_json ? (JSON.parse(event.before_json) as { strings?: unknown }) : null;
    const after = recordFor(event) as { strings?: unknown } | null;
    const old = new Set(Array.isArray(before?.strings) ? before.strings : []);
    const added = (Array.isArray(after?.strings) ? after.strings : []).filter(
      (value): value is string => typeof value === "string" && !old.has(value),
    );
    return event.kind === "changed" && added.some((value) => meaningfulWebString(value) && tellingWebString(value))
      ? "codename"
      : "evidence";
  }
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
    if (event.kind === "new") {
      /**
       * Weights in a registry are the earliest word on a model and the furthest from a reader
       * using one. Intern-S2-397B, Atria-Dawn-Preview and Atria-Dawn-Preview-Ascend-w8a8 all
       * reached the public channel as launches over two days: three separate repositories, none
       * of them callable without renting the hardware to serve it. A launch is a model somebody
       * can call, which is a row in an API catalogue.
       */
      if (event.stream === "weights" || listedButUnusable) return "codename";
      /**
       * And only in the catalogue of the company that made it. A platform listing somebody else's
       * model is a sighting, whoever owns the platform: `glm-5.3` appearing on Alibaba's DashScope
       * on 2026-09-15 reached the public channel as a launch, and Z.ai had shipped nothing that
       * day. Authority cannot answer this -- DashScope is first-party for Qwen and a reseller for
       * everyone else, and the Vercel gateway is recorded as vendor-owned while selling 26 makers'
       * models -- so the question is asked of the model's own name instead. Not of the record's
       * `maker`: the DashScope collector stamps "Alibaba Model Studio" on every row, GLM included.
       * A name that names nobody -- `whisper-1`, `codestral`, `wan2.5` -- is the catalogue's own.
       */
      return listsAnotherMakersModel(event) ? "codename" : "launch";
    }
    // Listed first and switched on later: the switch is the release. In the maker's own catalogue it
    // is a launch like any arrival would have been; anywhere else it is still a sighting.
    if (becameSelectable(event)) return listsAnotherMakersModel({ ...event, kind: "new" }) ? "codename" : "launch";
    // A row leaving a catalogue is not the vendor announcing anything: over the week to
    // 2026-09-15 the launch channel spent half its cards on four departures, each ending
    // something it had never been told arrived. It is a trail nobody has to read.
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
