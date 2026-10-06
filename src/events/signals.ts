import { text } from "../text.js";
import { boardPlace, DEBUT_PLACES, isTellableDebut, scoredDebutIndex } from "./boardSignals.js";
import { incidentIsSevere, incidentTouchesSubscribers } from "./incidents.js";
import { NEWSROOMS, newsClass, PRODUCT_BLOGS, patchBuild, RELEASE_NOTE_PAGES } from "./newsrooms.js";
import { pageClass } from "./pageSignals.js";
import { recordFor } from "./record.js";
import { becameSelectable, catalogueClass, isStealthLaunch } from "./resellers.js";
import { isAnnouncedArrival } from "./subject.js";
import type { Event, RecordData, SignalClass } from "./types.js";
import { meaningfulWebString, tellingWebString } from "./web.js";

export { SIGNAL_CLASSES, type SignalClass } from "./types.js";

/**
 * A place on a board moving is not a number a reader budgets with. Ten of them arrive in one
 * digest message and read as a wall, and the model they are about did not change: `change` is for
 * what a vendor did, `rank` for what a scoreboard did.
 *
 * An arrival is only news near the top, and only on a board this feed announces -- `subject.ts`
 * holds that list. A model debuting in the top ten of one is a `debut`, told to the public wire at
 * once; the same on any other board is still a sighting for the radar; anything lower is a row. On
 * 2026-09-13 Arena listed fifty models on a brand-new image-to-code board and every top-ten one
 * would have been a card: arrivals on a board that did not exist before are held back where the
 * collection is saved, which is the only place that knows the board is new.
 */
function boardClass(event: Event): SignalClass {
  if (event.kind !== "new") return "rank";
  const place = boardPlace(event);
  if (place !== null && place <= DEBUT_PLACES) return isAnnouncedArrival(event) ? "debut" : "codename";
  // Outside the ranked places only a first Artificial Analysis measurement says anything, and only
  // above the floor it sets: `isTellableDebut` is the same gate both delivery gates read, so a card
  // cannot be classed a debut here and then silenced as a row there. Below the floor the number is
  // still the first independent reading of a model, which is what the radar watches for.
  if (isTellableDebut(event)) return "debut";
  return scoredDebutIndex(event) === null ? "rank" : "codename";
}

/**
 * A retirement is read by whoever runs the model being retired, and that is a small, attentive
 * audience rather than the public one: the readers who came for what is new do not need a date on a
 * model they never called. A notice that names its successor is the earliest word on the model
 * replacing it, which is the same reason it belongs beside the codenames.
 */
function retirementClass(event: Event, record: RecordData | null): SignalClass {
  if (event.kind !== "new") return "evidence";
  return text(record?.replacement) ? "codename" : "evidence";
}

/**
 * An interface that starts naming a versioned model or a preview is a sighting; the rest of its
 * copy edits are a trail.
 */
function interfaceClass(event: Event): SignalClass {
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

/**
 * A slug appearing in the Codex client's model list, or one of them opening to more people, is the
 * model being prepared before anyone announces it.
 */
function codexSlugClass(event: Event, record: RecordData | null): SignalClass {
  if (event.kind === "new") return "codename";
  if (event.kind !== "changed") return "evidence";
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  return before?.visibility !== record?.visibility || JSON.stringify(before?.plans) !== JSON.stringify(record?.plans)
    ? "codename"
    : "evidence";
}

/**
 * A model a coding subscription starts offering free is news for a reader on a $20 plan: they can
 * use it today. Any other name entering those lists is a sighting.
 */
function codingListClass(event: Event, record: RecordData | null): SignalClass {
  const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
  const freed = record?.headline === true && before?.headline !== true;
  if (freed && event.kind !== "removed") return "launch";
  return event.kind === "new" ? "codename" : "evidence";
}

/**
 * One question the class is decided by, and the class it answers with.
 *
 * A list rather than a chain of `if`s, for the reason `STANDING_CHECKS` is one: the order is the
 * policy, and a chain can only be read by running it. That was not a style preference here. Eleven
 * v4 Turbo reached both public channels on 2026-10-05 and `prod why` printed twenty-nine standing
 * rules, every one of them silent, because the decision had been made a layer earlier where no
 * rule had a name. A week later `cohere/embed-v5.0-fast` went to the radar because the question
 * about the modality was asked three lines above the question about the maker, and a rule written
 * to demote a launch was promoting one out of `evidence` instead -- a bug whose entire substance
 * was an order nobody could see.
 *
 * So each question has a name, `classDecision` says which one spoke, and `prod why` prints it
 * beside the standing rules that were asked afterwards. A rule answers with a class or with null,
 * which is how one entry can hold a branch that reads two fields and still be one question.
 */
type ClassRule = { name: string; ask: (event: Event, record: RecordData | null) => SignalClass | null };

const CLASS_RULES: readonly ClassRule[] = [
  // A free model with no maker's name on it can be called the hour it appears, wherever it appears.
  { name: "free_and_unclaimed_at_a_reseller", ask: (e) => (isStealthLaunch(e) ? "launch" : null) },
  /**
   * A name leaving an arena ends nothing a reader was told had started, and it is the same shape as
   * a page that disappears, so it takes the same class. On 2026-09-15 193 of them reached the
   * invited room as sightings in sixteen messages; the arena had served a partial roster, and every
   * one of the 193 was back five minutes later under the same id.
   */
  {
    name: "a_name_on_an_arena",
    ask: (e) => (e.stream !== "arena" ? null : e.kind === "new" || becameSelectable(e) ? "codename" : "evidence"),
  },
  { name: "a_probe_found_it", ask: (e) => (e.source.startsWith("discovery:") ? "codename" : null) },
  /**
   * A bet is never the news. A market opening on a name, or repricing a date, is the raw trail for
   * whoever is already following that name -- the class that reaches no reader on its own -- and it
   * stays that whichever way the price went. Whether a market ever leads a sighting is a question
   * for `lead-time` after the source has collected for a while, not one settled by a class here.
   */
  { name: "a_market_priced_a_name", ask: (e) => (e.stream === "markets" ? "evidence" : null) },
  // A lab training a named model in public is the earliest word on it, and a run ending is the next.
  { name: "a_lab_training_in_public", ask: (e) => (e.stream === "training" ? "codename" : null) },
  { name: "a_place_on_a_board", ask: (e) => (e.stream === "leaderboards" ? boardClass(e) : null) },
  {
    name: "a_retirement_notice",
    ask: (e, record) => (e.stream === "deprecations" ? retirementClass(e, record) : null),
  },
  /**
   * A newsroom is not a release feed. Every vendor mixes releases with research, policy and
   * customer stories under one heading, and Anthropic grades nine posts out of ten as
   * "Announcements", so the source cannot be asked which is which. It does not have to be: a model
   * a reader can use appears in the vendor's own catalogue, which is where the launch is observed.
   * The post is what the vendor said about it.
   */
  { name: "a_newsroom_post", ask: (e, record) => (e.stream === "news" ? newsClass(e, record) : null) },
  // An app build is a version number and store copy; nothing here reads what changed in it yet.
  { name: "an_app_build", ask: (e) => (e.stream === "apps" ? "evidence" : null) },
  // A page appearing on a vendor site before any announcement is the same kind of tell as an
  // unreleased model on an arena. A page that leaves is evidence, not a signal to wake anyone.
  { name: "a_page_on_a_vendor_site", ask: (e) => (e.stream === "pages" ? pageClass(e) : null) },
  { name: "an_interface_string", ask: (e) => (e.stream === "web" ? interfaceClass(e) : null) },
  { name: "a_package_version", ask: (e) => (e.stream === "packages" ? "evidence" : null) },
  // A major outage is the one incident that has to interrupt: it travels with the launches, which
  // is where everything a reader must act on right now already goes. Everything else the vendors
  // grade lower is on the board and nowhere else.
  // Only a subscriber's product: an API outage is the builders' news, and the board carries it.
  {
    name: "an_outage",
    ask: (e) =>
      e.stream !== "incidents" ? null : incidentIsSevere(e) && incidentTouchesSubscribers(e) ? "launch" : "incident",
  },
  /**
   * Limits coming back is the most direct "you can use this now" in the system: nothing was
   * released, but a reader who ran out an hour ago can work again, and only for the next few
   * hours. It reads as a number moving and behaves like a launch, so it travels with the launches.
   *
   * A reset is announced in two steps by the same person -- promised, then applied -- and both
   * steps are news, so both are launches and both reach the same channel.
   */
  { name: "limits_coming_back", ask: (e) => (e.stream === "resets" ? "launch" : null) },
  {
    name: "a_slug_in_the_codex_client",
    ask: (e, record) => (e.source === "codex-models" ? codexSlugClass(e, record) : null),
  },
  {
    name: "a_coding_subscriptions_own_model_list",
    ask: (e, record) => (CODING_SUBSCRIPTION_LISTS.has(e.source) ? codingListClass(e, record) : null),
  },
  // A model id entering the Claude Code binary, a launch page or a price list is the same early
  // word; one leaving is not news.
  {
    name: "a_model_id_in_a_binary_a_sitemap_or_a_price_list",
    ask: (e) => (EARLY_WORD_SOURCES.has(e.source) ? (e.kind === "new" ? "codename" : "evidence") : null),
  },
  // A model ID written into code for the first time, which no catalogue here has listed: the same
  // early word as a slug entering the Codex model list.
  {
    name: "a_model_id_written_into_code",
    ask: (e) => (e.stream === "github" && isModelSighting(e) ? (e.kind === "new" ? "codename" : "evidence") : null),
  },
  {
    name: "a_repository_release",
    ask: (e) =>
      e.stream !== "github"
        ? null
        : e.source.endsWith(":releases") && e.kind === "new" && !patchBuild(recordFor(e))
          ? "release"
          : "evidence",
  },
  {
    name: "a_row_in_a_catalogue",
    ask: (e, record) => (["api-models", "openrouter", "weights"].includes(e.stream) ? catalogueClass(e, record) : null),
  },
];

/** The coding subscriptions whose own model list is this feed's subject answering for itself. */
const CODING_SUBSCRIPTION_LISTS = new Set(["opencode-zen", "opencode-go", "command-code-models"]);

/** The sources where a model id first appears in something shipped rather than announced. */
const EARLY_WORD_SOURCES = new Set([
  "claude-code-models",
  "anthropic-routes",
  "google-skus",
  "openai-sitemap",
  "deepmind-sitemap",
  "anthropic-sitemap",
  "xiaomi-sitemap",
  "zai-sitemap",
  "meta-blog",
  "qwen-blog",
  "minimax-release-notes",
  "kimi-docs",
  "zai-release-notes",
  "deepseek-sitemap",
]);

/** The class nothing claimed: a number moved, and no question above had anything to say about it. */
const A_NUMBER_MOVED = { rule: "a_number_moved", signal: "change" } as const;

/** Which question decided the class of an event, and what it answered. */
export function classDecision(event: Event): { rule: string; signal: SignalClass } {
  const record = recordFor(event);
  for (const rule of CLASS_RULES) {
    const signal = rule.ask(event, record);
    if (signal) return { rule: rule.name, signal };
  }
  return A_NUMBER_MOVED;
}

/** The names of every class question, in the order they are asked. */
export function classRuleNames(): string[] {
  return [...CLASS_RULES.map((rule) => rule.name), A_NUMBER_MOVED.rule];
}

/**
 * The class of an event, derived from the same evidence the card is rendered from.
 *
 * `launch`: something a reader can call now, or an outage the vendor graded severe that has just
 *   started. A row appearing in the vendor's own API catalogue, and the maker's own post saying its
 *   own model exists -- that post is the launch as its maker tells it, and it reaches the same
 *   readers for the same reason, which is why it is this class rather than a second one beside it.
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
 * `feature`: a vendor saying a product a reader already uses can now do something new. "Introducing
 *   the Agents API" is a card; it was an article until 2026-09-19 and reached nobody.
 * `safety`, `research`: what a vendor said about misuse, security and model behaviour, or about
 *   what it found. Read once a day in one message on the public wire, never as cards: OpenAI filed
 *   eight "Disrupting malicious uses" reports in a single afternoon.
 * `business`: customer stories, partnerships, programmes, hires, events, policy. Kept, not sent.
 * `debut`: a model that was not on a main scoreboard taking a place in its top ten, or one
 *   Artificial Analysis has measured for the first time at an Intelligence Index worth reporting.
 *   How good a new model is, which the launch card could not say.
 */
export function signalClass(event: Event): SignalClass {
  return classDecision(event).signal;
}

/**
 * A role mention interrupts a person's day, so it is reserved for the two classes they subscribed
 * for. Numbers moving and raw evidence never ping.
 */
export function isModelSighting(event: Event): boolean {
  return event.stream === "github" && /^github:.+:(?:models|talk)$/.test(event.source);
}

/**
 * Whether a role is mentioned for this event at all.
 *
 * Only what a maker has actually done pings: a launch, a feature, a promised reset. Two classes
 * that used to ping no longer do.
 *
 * A sighting does not, whatever stage it reached. `codename` is the radar's whole feed, and over
 * 2026-09-24..26 it produced fifteen of the nineteen cards there, every one of them mentioning a
 * vendor role: @Anthropic for `claude-haiku-4-5-direct-anthropic`, a line in a stranger's litellm
 * config, and @OpenAI for `gpt-6-sol-medium-fast`, an effort setting of a model announced three
 * days earlier. A reader who opens the radar is already looking; a reader who is not does not need
 * to be interrupted by a name somebody wrote in a YAML file. `debut` goes with it: a place on a
 * scoreboard is a number moving, which this comment already said never pings.
 *
 * An outage does not. `signalClass` promotes a severe incident to `launch` so that it travels with
 * the launches, and that promotion reached the ping rule too: "Issues with Codex" mentioned
 * @OpenAI on 2026-09-25. The status page is where an outage is read, and a reader who is blocked by
 * one has already noticed. It still reaches the news channel as a card; it no longer taps anyone.
 */
export function pingWorthy(event: Event): boolean {
  if (event.stream === "incidents") return false;
  const signal = signalClass(event);
  // A promised reset pings too: "Codex limits reset announced" on 2026-09-22 reached the OpenAI
  // role's readers without a mention, and a reset is the news a Codex subscriber waits for.
  return signal === "launch" || signal === "feature";
}

/**
 * Where a maker speaks for itself: its blog, its release notes, its own documentation pages.
 *
 * A catalogue row says a model is listed today; only an announcement says it happened today. The
 * distinction is what keeps a week, or a count of agreeing sources, from reading three catalogues
 * catching up on an August release as news.
 */
export const ANNOUNCEMENT_STREAMS = new Set(["news", "pages", "changelog"]);

/**
 * The model lists the coding tools themselves ship, which is this feed's subject answering for it.
 *
 * A maker nobody has heard of is normally the end of the question -- `isRealArrival` drops an
 * Unknown vendor because no benchmark, arena or API has anything to say about it. But a model a
 * coding agent has added to its own list of models is one this feed's readers can select this
 * minute, and that is a stronger answer than recognising the maker's name: Ling 3.1 Flash reached
 * OpenCode before it reached anything that knew who InclusionAI were.
 *
 * Only the curated lists. `discovery:opencode-data` is a dump of everything OpenCode has ever
 * known, and it named `gpt-3.5-turbo`, `gpt-4` and nine Command snapshots in one call on
 * 27 September.
 */
export const CODING_TOOL_SOURCES = new Set([
  "claude-code-models",
  "command-code-models",
  "qwen-code-models",
  "opencode-zen",
  "opencode-go",
  "github:anomalyco/opencode:models",
  "github:MiniMax-AI/minimax-code:models",
  "github:openai/codex:models",
]);

/**
 * A post the model's own maker wrote about it.
 *
 * The catalogue says a model is callable; the post is the page a reader opens to find out what it
 * is. Anthropic's Claude Opus 5.5 post and OpenAI's GPT-6 Sol and Luna post both arrived within
 * half an hour of the catalogue card on 2026-09-22 and both were dropped as a story already told,
 * so the link nobody could do without never reached anyone.
 */
export function isMakersAnnouncement(event: Event): boolean {
  if (event.kind !== "new" || event.stream !== "news") return false;
  if (!NEWSROOMS.has(event.source) && !PRODUCT_BLOGS.has(event.source) && !RELEASE_NOTE_PAGES.has(event.source))
    return false;
  return ["launch", "release", "feature"].includes(signalClass(event));
}
