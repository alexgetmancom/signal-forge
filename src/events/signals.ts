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
  "feature",
  "safety",
  "research",
  "business",
  "debut",
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
 * `feature`: a vendor saying a product a reader already uses can now do something new. "Introducing
 *   the Agents API" is a card; it was an article until 2026-09-19 and reached nobody.
 * `safety`, `research`: what a vendor said about misuse, security and model behaviour, or about
 *   what it found. Read once a day in one message on the public wire, never as cards: OpenAI filed
 *   eight "Disrupting malicious uses" reports in a single afternoon.
 * `business`: customer stories, partnerships, programmes, hires, events, policy. Kept, not sent.
 * `debut`: a model that was not on a main scoreboard taking a place in its top ten. How good a new
 *   model is, which the launch card could not say.
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
  "gemini-models-blog",
  "gemini-app-blog",
  "deepmind-blog",
  "nvidia-developer-blog",
  "openai-alignment",
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
  /\b(?:claude|opus|sonnet|haiku|fable|mythos|gpt|o\d|gemini|gemma|grok|codex|llama|qwen|deepseek|kimi|glm|mistral|minimax)[\s-]?\d/i;

/**
 * The changelogs of the tools and APIs the public channel's readers work in. A version of an SDK or
 * a vendor's hardware feed is a build, not something a Claude Code or Codex user changes their day
 * for, and stays evidence. So do the OpenAI and Gemini API changelogs: on 2026-09-17 the owner read
 * "Responses API accepts more file types" and a swap of one Antigravity preview for the next on
 * the public channel and called both noise. A model reaching those APIs is seen in the catalogue.
 */
/**
 * A build whose last number moved is a patch. Claude Code shipped 2.1.268 to 2.1.278 in nine days
 * and every one reached the signals channel as a release card; nobody reading it acts on a patch.
 * A minor or major build (X.Y.0), and a release named rather than numbered, still travel.
 */
const PATCH_BUILD = /(?:^|[^\w.])v?\d+\.\d+\.([1-9]\d*)(?![\w.])/;
function patchBuild(record: Record<string, unknown> | null | undefined): boolean {
  return PATCH_BUILD.test(`${text(record?.version) ?? ""} ${text(record?.name) ?? ""}`);
}

const TOOL_CHANGELOGS = new Set([
  "claude-code-changelog",
  "openai-codex-changelog",
  "cursor-changelog",
  "kimi-code-changelog",
  "minimax-code-changelog",
  "openai-chatgpt-release-notes",
  "xai-release-notes",
  "mistral-release-notes",
  "deepseek-updates",
]);

/**
 * ChatGPT's release notes are mostly consumer features. "Credit scores in Finances" reached the
 * public channel on 2026-09-21 and the owner called it noise: a reader here came for models and the
 * tools they build with. An entry travels only when it names a model or a builder's surface.
 */
const CHATGPT_FOR_BUILDERS =
  /\b(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|grok|codex|model|models|api|developers?|agents?|apps sdk|mcp|connectors?|reasoning|context window)\b[\s-]?\d?/i;

/**
 * Watched sites whose new pages are not the tell a product page is.
 *
 * A page appearing on a vendor's product site before any announcement is a sighting. A help-centre
 * article is not: "set up Salesforce in Claude" and "let team members run smart reports" reached
 * the invited room as sightings on 2026-09-15, and a reader who came to hear about models cannot
 * do anything with either. A developer blog is a blog, and its posts are what the vendor said.
 */
const HELP_CENTRES = new Set(["pages:claude-support"]);

/**
 * A new page is a sighting only when it names a versioned product or sits among the model pages.
 * Over 2026-09-17 and 18 the scouts carried "Measuring pace of AI development", "Accenture embedded
 * evaluation", "Life sciences verification program", "Lyria prompt guide" and an industry page
 * titled "Law" beside the real tells, "Gemini 3.8 Live" and "Grok voice transcribe 2". Research,
 * customer stories, partner pages and guides are what the vendor said, which is an article.
 */
const PRODUCT_WITH_VERSION =
  /\b(?:claude|opus|sonnet|haiku|fable|mythos|gpt|gemini|gemma|grok|codex|llama|qwen|deepseek|kimi|glm|mistral|minimax|mimo|imagen|veo|lyria|sora|astra)\b(?:[\s-]+[a-z]+){0,3}[\s-]+v?\d/i;
const MODEL_PAGE_PATH = /\/(?:models?|model-cards)\//i;
function pageNamesAProduct(record: Record<string, unknown> | null | undefined): boolean {
  const path = text(record?.id) ?? "";
  const words = `${text(record?.name) ?? ""} ${path.replaceAll(/[/_-]+/g, " ")}`;
  return MODEL_PAGE_PATH.test(path) || NAMES_A_MODEL.test(words) || PRODUCT_WITH_VERSION.test(words);
}
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
 * A preview replaced by the next preview. "Released antigravity-preview-09-2026, which replaces and
 * deprecates antigravity-preview-05-2026" reached the public channel as a retirement on 2026-09-17:
 * nothing a reader runs goes away, the preview string moves on.
 */
const PREVIEW_SUCCESSION = /\bpreview\S*[^.]*\b(?:replac|supersed|deprecat)\w*[^.]*\bpreview\b/i;

/**
 * How old a dated entry may be when it is first seen or edited and still be news. OpenAI rewrote its
 * entry of 2026-02-24 on 2026-09-17 to name the Responses API, and the edit reached the public
 * channel as a change seven months after the feature shipped. A parser that starts reading more of a
 * page finds old posts the same way: the Anthropic newsroom fix of 2026-09-17 surfaced "Introducing
 * Claude Fable 5.1", sixteen days after the launch.
 */
const NEWS_FOR_MS = 7 * 24 * 3_600_000;

function publishedLongAgo(event: Event, published: unknown): boolean {
  const at = Date.parse(text(published) ?? "");
  return Number.isFinite(at) && Date.parse(event.detected_at) - at > NEWS_FOR_MS;
}

/**
 * Claude's product blog mixes launches with customer stories. A title that says something became
 * available is the product changing for the reader; "What 1,000 small business owners taught us" is
 * not. "Claude Cowork and chat are now one Claude" on 2026-09-16 is the case it exists for.
 */
const PRODUCT_BLOGS = new Set(["claude-blog"]);
const SHIPS =
  /\b(introducing|announcing|launch(?:es|ing)?|is now|are now|now (?:available|supports?)|generally available|new in|redesigned)\b/i;

/**
 * What a vendor's post is about, once it is not a launch.
 *
 * Every newsroom mixes these under one heading, and on 2026-09-19 fourteen days of them were read
 * by hand: eight OpenAI misuse reports, a misalignment framework and Anthropic's misuse review
 * (safety); a pace-of-development study, a KV-cache write-up and a biomolecular model (research);
 * the Agents API (a feature); and customer stories, partnerships, programmes, a conference and an
 * astronaut interview (business). Asked in that order, because the question that decides where a
 * post goes is the first one it answers: "Introducing the Australian Youth Safety Blueprint" is
 * safety before it is a programme, and "Partnering with Accenture" is business before it is an
 * evaluation. What answers none of them stays an article, the day's "other".
 */
const SAFETY =
  /\b(safety|misuse|malicious|misalign\w*|jailbreak\w*|vulnerab\w*|exploit\w*|security|cyber\w*|threat\w*|scams?|fraud\w*|influence (?:operations?|activity|planning)|disrupting|abuse|red[- ]team\w*|guardrails?|concerning|secretly|silently|leak(?:s|ed)?|breach\w*|hack(?:ing|ed)?|incidents?|attacks?|decept\w*|sabotage|backdoor\w*)\b|^operation\b/i;
const BUSINESS =
  /\b(customers?|case stud\w*|helps?|trusts?|partner\w*|joins|board|hires?|appoint\w*|funding|grants?|econom\w*|polic(?:y|ies)|government\w*|federal|election\w*|journalism|advertising|fashion|devfest|summit|conference|webinar|watch|podcast|interview|award\w*|program(?:me)?s?|blueprint|initiatives?|workers?|older adults|teens?|youth|students?|classrooms?|productivity|for (?:law|legal|financial services|finance|healthcare|education|business|enterprises?|nonprofits)|(?:with|using) (?:chatgpt|codex|claude|gemini|gpt\S*))\b/i;
const RESEARCH =
  /\b(research|paper|stud(?:y|ies)|measur\w*|benchmark\w*|evaluat\w*|interpretab\w*|alignment|scaling laws?|pace of|prize problem|theorem|proofs?|technical report|architecture|kv cache|compression|inference infrastructure|under the hood|toward|towards|pre-?training|post-?training|distillation|tokeni[sz]\w*|scien\w*|molecul\w*|biomolecular|quantum)\b/i;
const FEATURE_VERB =
  /\b(introducing|announcing|launch(?:es|ing)?|is now|are now|now (?:available|supports?|reads?|can)|generally available|new in|in the api)\b/i;
const PRODUCT =
  /\b(api|apis|chatgpt|claude|codex|gemini|grok|cowork|sora|agents?|app|apps|cli|sdk|voice|search|memory|projects|connectors?|plugins?|extensions?|browser|mode)\b/i;

function articleTopic(event: Event): "feature" | "safety" | "research" | "business" | "article" {
  const record = recordFor(event);
  const title = `${text(record?.name) ?? ""} ${event.stream === "pages" ? (text(record?.id) ?? "").replaceAll(/[/_-]+/g, " ") : ""}`;
  const firstParty = event.source !== "hackernews" && event.kind === "new";
  // Everything an alignment team publishes is about how models misbehave, whatever its title says.
  if (event.source === "openai-alignment" || SAFETY.test(title)) return "safety";
  // "Build voice experiences with GPT-Live-1 in the API" reads like a customer story and is a
  // capability reaching developers.
  if (firstParty && /\bin the api\b/i.test(title)) return "feature";
  if (BUSINESS.test(title)) return "business";
  if (RESEARCH.test(title)) return "research";
  // Somebody else saying a product changed is a claim about it, not the vendor shipping it: a card
  // needs the vendor's own word, so Hacker News never announces a feature.
  if (firstParty && FEATURE_VERB.test(title) && PRODUCT.test(title)) return "feature";
  return "article";
}

/**
 * A place on a scoreboard people quote. A top-ten debut here is what a reader repeats about a new
 * model; the design and niche boards are sightings for the scouts when they are anything at all.
 */
const MAIN_BOARDS = new Set([
  "text/overall",
  "code/overall",
  "vision/overall",
  "text-to-image/overall",
  "image-edit/overall",
  "text-to-video/overall",
  "image-to-video/overall",
  "artificial-analysis/quality",
  "artificial-analysis/text-to-image",
  "artificial-analysis/image-editing",
  "artificial-analysis/text-to-speech",
  "artificial-analysis/text-to-video",
]);
/** Only the top ten is news; below it a new name is a row. */
export const DEBUT_PLACES = 10;

/**
 * A model Artificial Analysis has measured, arriving outside the places it ranks.
 *
 * The site ranks only its leading twenty, so a model below them has no place at all and every
 * arrival there was a `rank` -- the class the daily recap empties, 3250 events in the week to
 * 2026-09-20 against 34 delivered. That is right for the boards where a new row is a row, and wrong
 * here: this site does not list a model until it has run the benchmarks, so an arrival carries a
 * measured Intelligence Index and is a claim about the model rather than about the board. Step 5
 * Preview arrived at 43.6, was named in the recap as one line among six, and waited a day for a
 * gateway and a mirror to agree before anything else happened.
 *
 * It is a sighting for the scouts, not the public wire. The number says a real model exists and
 * performs; it does not say anyone can call it, and on this board a preview sits beside shipped
 * models with no way to tell them apart. The top ten still goes out as a `debut`.
 *
 * There is deliberately no floor on the index. One would have to be a number on a scale that moves
 * as the benchmarks are rewritten, and the board's own cutoff is not in hand here. The cost of that
 * is a card for a weak arrival, which is why `passed-over` and the next `channel-mix` reading are
 * scheduled against this rule rather than a guess being tuned now.
 */
export function scoredDebutIndex(event: Event): number | null {
  if (event.source !== "artificial-analysis" || event.stream !== "leaderboards" || event.kind !== "new") return null;
  const place = boardPlace(event);
  if (place !== null && place <= DEBUT_PLACES) return null;
  const record = recordFor(event);
  if (!isMainBoard(record?.category)) return null;
  const score = record?.score;
  if (typeof score !== "object" || score === null) return null;
  const index = (score as Record<string, unknown>).artificial_analysis_intelligence_index;
  return typeof index === "number" && Number.isFinite(index) ? index : null;
}

/** The place a new board entry took, when it is a real one: a board once served a model at #0. */
export function boardPlace(event: Event): number | null {
  const rank = recordFor(event)?.rank;
  return typeof rank === "number" && Number.isInteger(rank) && rank >= 1 ? rank : null;
}

export function isMainBoard(category: unknown): boolean {
  return typeof category === "string" && MAIN_BOARDS.has(category);
}

/**
 * The maker whose own models an API catalogue sells. A catalogue absent here sells other makers'
 * models -- Groq, Cerebras, the Vercel gateway -- and never launches anything itself.
 */
export const CATALOGUE_MAKER: Readonly<Record<string, string>> = {
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

/**
 * A lab nobody follows here, listed by a reseller: told the next morning, not at once.
 *
 * Six of these reached the scouts as cards between 2026-09-16 and 19 -- Typesafe's Jev, Unbiased's
 * Pareto, PrismML's Bonsai, Mixedbread's Toast, QuiverAI's Arrow twice -- and five were a catalogue
 * growing. The sixth, Jev, was the week's breakout: the Vercel gateway listed it fifteen hours
 * before any other catalogue and thirty repositories were built on it within three days. Whether a
 * maker is followed is what this tracker knows, not what the model is worth, so none of them is
 * dropped. Each is a line in the scouts' morning, and a card the moment it takes off (see
 * `breakouts.ts`), after which its maker is followed and the next model is a card on arrival.
 *
 * A stealth model hides its maker on purpose and is exactly what the scouts are for, and a row that
 * names no maker cannot be judged small; both stay sightings.
 */
const STEALTH = /^(?:stealth|openrouter|cloaked|anonymous)\/|\b(?:stealth|cloaked)\b/i;

/** The maker a reseller's row names: its own attribution, or the namespace of the id. */
export function resellerMaker(event: Event): string | null {
  const record = recordFor(event);
  const id = text(record?.id) || event.entity_id;
  const words = `${id} ${text(record?.name) ?? ""}`;
  if (STEALTH.test(id) || STEALTH.test(words)) return null;
  return text(record?.maker) || (id.includes("/") ? id.split("/")[0] || null : null);
}

export function isUnfollowedMakerAtAReseller(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  if (!listsAnotherMakersModel(event)) return false;
  const maker = resellerMaker(event);
  if (!maker) return false;
  const record = recordFor(event);
  return vendorOfName(`${maker} ${text(record?.id) || event.entity_id} ${text(record?.name) ?? ""}`) === "Unknown";
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
   * A bet is never the news. A market opening on a name, or repricing a date, is the raw trail for
   * whoever is already following that name -- the class that reaches no reader on its own -- and it
   * stays that whichever way the price went. Whether a market ever leads a sighting is a question
   * for `lead-time` after the source has collected for a while, not one settled by a class here.
   */
  if (event.stream === "markets") return "evidence";
  // A lab training a named model in public is the earliest word on it, and a run ending is the next.
  if (event.stream === "training") return "codename";

  /**
   * A place on a board moving is not a number a reader budgets with. Ten of them arrive in one
   * digest message and read as a wall, and the model they are about did not change: `change` is for
   * what a vendor did, `rank` for what a scoreboard did.
   */
  //
  // An arrival is only news near the top. A model debuting in the top ten of a board people quote
  // is a `debut`, told to the public wire at once; the same on a niche board is still a sighting for
  // the scouts; anything lower is a row. On 2026-09-13 Arena listed fifty models on a brand-new
  // image-to-code board and every top-ten one would have been a card: arrivals on a board that did
  // not exist before are held back where the collection is saved, which is the only place that
  // knows the board is new.
  if (event.stream === "leaderboards") {
    if (event.kind !== "new") return "rank";
    const place = boardPlace(event);
    if (place === null || place > DEBUT_PLACES) return scoredDebutIndex(event) === null ? "rank" : "codename";
    return isMainBoard(recordFor(event)?.category) ? "debut" : "codename";
  }

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
    if (publishedLongAgo(event, record?.published)) return "evidence";
    if (PRODUCT_BLOGS.has(event.source)) {
      if (event.kind === "new" && SHIPS.test(text(record?.name) ?? "")) return "release";
      return event.kind === "new" ? articleTopic(event) : "article";
    }
    if (NEWSROOMS.has(event.source)) {
      const title = text(record?.name) ?? "";
      if (event.kind === "new" && ANNOUNCES.test(title) && NAMES_A_MODEL.test(title)) return "launch";
      return event.kind === "new" ? articleTopic(event) : "article";
    }
    if (event.kind !== "new") return "change";
    /**
     * A record carrying a version is a tool shipping a build: Claude Code 2.1.271, 2.1.272 and
     * 2.1.273 landed in the invited room inside a day, and nobody there is subscribed to patch
     * notes. A dated entry with no version is the vendor saying something, and the only thing it
     * says that a reader must act on by a date is that a model is going away.
     */
    const words = `${text(record?.name)} ${text(record?.summary)} ${text(record?.description)}`;
    if (!text(record?.version) && RETIREMENT_WORDS.test(words) && !PREVIEW_SUCCESSION.test(words)) return "retirement";
    if (event.source === "openai-chatgpt-release-notes" && !CHATGPT_FOR_BUILDERS.test(words)) return "evidence";
    return TOOL_CHANGELOGS.has(event.source) && !patchBuild(record) ? "release" : "evidence";
  }

  // An app build is a version number and store copy; nothing here reads what changed in it yet.
  if (event.stream === "apps") return "evidence";

  // A page appearing on a vendor site before any announcement is the same kind of tell as an
  // unreleased model on an arena. A page that leaves is evidence, not a signal to wake anyone.
  if (event.stream === "pages") {
    if (HELP_CENTRES.has(event.source)) return "evidence";
    if (PAGE_BLOGS.has(event.source)) return event.kind === "new" ? articleTopic(event) : "article";
    if (event.kind !== "new") return "evidence";
    return pageNamesAProduct(recordFor(event)) ? "codename" : articleTopic(event);
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

  // A slug appearing in the Codex client's model list, or one of them opening to more people, is
  // the model being prepared before anyone announces it.
  if (event.source === "codex-models") {
    if (event.kind === "new") return "codename";
    if (event.kind !== "changed") return "evidence";
    const before = event.before_json ? (JSON.parse(event.before_json) as Record<string, unknown>) : null;
    const after = recordFor(event);
    return before?.visibility !== after?.visibility || JSON.stringify(before?.plans) !== JSON.stringify(after?.plans)
      ? "codename"
      : "evidence";
  }
  // A model ID written into code for the first time, which no catalogue here has listed: the same
  // early word as a slug entering the Codex model list.
  if (event.stream === "github" && isModelSighting(event)) return event.kind === "new" ? "codename" : "evidence";
  if (event.stream === "github")
    return event.source.endsWith(":releases") && event.kind === "new" && !patchBuild(recordFor(event))
      ? "release"
      : "evidence";

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
      if (!listsAnotherMakersModel(event)) return "launch";
      return isUnfollowedMakerAtAReseller(event) ? "evidence" : "codename";
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
function isModelSighting(event: Event): boolean {
  return event.stream === "github" && /^github:.+:(?:models|talk)$/.test(event.source);
}

export function pingWorthy(event: Event): boolean {
  // A promised reset is worth reading and not worth interrupting: nothing has come back yet, and
  // the same announcement pings for real when it is applied.
  if (event.stream === "resets" && recordFor(event)?.stage !== "Applied") return false;
  // A model written into code is coming; one answering people is here. Only the second interrupts.
  if (isModelSighting(event) && recordFor(event)?.stage !== "served") return false;
  const signal = signalClass(event);
  return signal === "launch" || signal === "codename" || signal === "feature" || signal === "debut";
}

/**
 * Where a maker speaks for itself: its blog, its release notes, its own documentation pages.
 *
 * A catalogue row says a model is listed today; only an announcement says it happened today. The
 * distinction is what keeps a week, or a count of agreeing sources, from reading three catalogues
 * catching up on an August release as news.
 */
export const ANNOUNCEMENT_STREAMS = new Set(["news", "pages", "changelog"]);
