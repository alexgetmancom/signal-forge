/**
 * What a vendor wrote, and which of the written classes it is.
 *
 * A newsroom post, a product blog entry, a tool changelog and a consumer app's release notes all
 * arrive as one stream and are told apart by their words: who published it, whether the title says
 * something arrived, whether it was written for a builder or a subscriber, whether it says a model
 * is going away. Every word list that answers one of those, and `newsClass`, which asks them in
 * order, lives here.
 */
import { text } from "../text.js";
import { recordFor } from "./record.js";
import type { Event, RecordData, SignalClass } from "./types.js";

/**
 * A blog, as opposed to a changelog. Google's belongs here for the same reason OpenAI's does: two
 * of the two posts it published by 2026-09-15 were a conference promotion and an astronaut
 * interview, and it is also where a Gemini launch would appear. Left out of this set its posts were
 * classed `release`, which is the class reserved for a changelog entry, and the newsroom filter --
 * which reads the class -- never looked at them.
 */
export const NEWSROOMS = new Set([
  "openai-news",
  "anthropic-news",
  "huggingface-blog-feed",
  "google-ai-blog",
  "gemini-models-blog",
  "gemini-app-blog",
  "deepmind-blog",
  "nvidia-developer-blog",
  "openai-alignment",
  "openai-deployment-safety",
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
/**
 * A post that opens by saying the maker is announcing something.
 *
 * A title is a headline before it is a sentence, and a maker is free to write one that says nothing
 * about what it is doing: "Gemini 4 Argon: our next era of frontier intelligence" on 2026-09-30
 * carried no verb of arrival, was classed `article`, and the launch of the day reached the public
 * channels only as a Hacker News link to the same post thirty-one minutes later. The body of that
 * post begins "Announcing Gemini 4 Argon". Anchored at the opening because an announcement says so
 * first: "announcing" in the ninth paragraph of a research write-up is a word, not the subject.
 */
const OPENS_BY_ANNOUNCING =
  /^\s*(?:today,?\s*)?(?:we(?:'re|'ve| are| have)\s+)?(?:introducing|announcing|launching)\b/i;
export function opensByAnnouncing(record: RecordData | null | undefined): boolean {
  return OPENS_BY_ANNOUNCING.test(text(record?.summary) ?? text(record?.description) ?? "");
}

export const NAMES_A_MODEL =
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
export function patchBuild(record: Record<string, unknown> | null | undefined): boolean {
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
 * Release notes written for the people using the chat app, not the people building on the API.
 *
 * Mistral's page reads like ChatGPT's: "Le Chat: memories you can edit" on 2026-09-22 reached the
 * public channel beside a Codex reset. A Mistral *model* release still speaks -- it is the same
 * page, and the same question answers both.
 */
const CONSUMER_APP_NOTES = new Set(["openai-chatgpt-release-notes", "mistral-release-notes"]);

/**
 * ChatGPT's release notes are mostly consumer features. "Credit scores in Finances" reached the
 * public channel on 2026-09-21 and the owner called it noise: a reader here came for models and the
 * tools they build with. The collector asks a judge who each entry is for (`audience`); this word list
 * decides only when the judge could not be asked.
 */
const FOR_BUILDERS =
  /\b(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|grok|codex|model|models|api|developers?|agents?|apps sdk|mcp|connectors?|reasoning|context window)\b[\s-]?\d?/i;

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
export const PRODUCT_BLOGS = new Set(["claude-blog"]);
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

export function articleTopic(event: Event): "feature" | "safety" | "research" | "business" | "article" {
  const record = recordFor(event);
  const title = `${text(record?.name) ?? ""} ${event.stream === "pages" ? (text(record?.id) ?? "").replaceAll(/[/_-]+/g, " ") : ""}`;
  const firstParty = event.source !== "hackernews" && event.kind === "new";
  // Everything an alignment team publishes is about how models misbehave, and a system card is the
  // safety report on one model, whatever either of them puts in a title.
  if (event.source === "openai-alignment" || event.source === "openai-deployment-safety" || SAFETY.test(title))
    return "safety";
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
 * A post about a command-line program, or about how one behaves in a terminal.
 *
 * The readers of this feed run Codex Desktop and Claude Code Desktop, which are windows, not
 * terminals. Kimi Code CLI v2.1.0 reached the news channel on 2026-09-23 to say its transcript now
 * scrolls on its own and text can be selected with the mouse -- true, and about a program none of
 * them open. A build that carries a model, a price or a limit is not this: those words are read
 * before the terminal is, so a release that ships something stays a release.
 */
const TERMINAL_TOOL = /\b(cli|tui|terminal|command[\s-]line|shell|keybinds?|keybindings?|ncurses)\b/i;
const SHIPS_SOMETHING = /\b(model|models|pricing|price|limits?|quota|context|agent|agents|subscription|plan|plans)\b/i;

function isAboutTheTerminal(event: Event, record: RecordData | null): boolean {
  if (event.kind !== "new") return false;
  const words = `${text(record?.name) ?? ""} ${text(record?.summary) ?? ""} ${text(record?.description) ?? ""}`;
  return TERMINAL_TOOL.test(words) && !SHIPS_SOMETHING.test(words);
}

/** A maker's own dated release-notes page, as distinct from a newsroom's posts. */
export const RELEASE_NOTE_PAGES = new Set([
  "xai-release-notes",
  "mistral-release-notes",
  "openai-api-changelog",
  "gemini-api-changelog",
]);

/**
 * What a dated entry on a vendor's own pages is, once the stream says it is one.
 *
 * Every question below is about the written word -- who published it, whether it announces, who it
 * was written for -- so the whole branch lives beside the word lists that answer them rather than
 * in `signalClass`, where it was the longest of the fifteen streams.
 */
export function newsClass(event: Event, record: RecordData | null): SignalClass {
  if (publishedLongAgo(event, record?.published)) return "evidence";
  if (isAboutTheTerminal(event, record)) return "evidence";
  if (PRODUCT_BLOGS.has(event.source)) {
    if (event.kind === "new" && SHIPS.test(text(record?.name) ?? "")) return "release";
    return event.kind === "new" ? articleTopic(event) : "article";
  }
  if (NEWSROOMS.has(event.source)) {
    const title = text(record?.name) ?? "";
    if (event.kind === "new" && (ANNOUNCES.test(title) || opensByAnnouncing(record)) && NAMES_A_MODEL.test(title))
      return "launch";
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
  if (CONSUMER_APP_NOTES.has(event.source)) {
    // The judge's answer when it gave one, the word list when it could not be asked.
    const audience = text(record?.audience);
    // The fallback reads the heading only: an app feature described at length says "agent" or
    // "model" somewhere in its copy, and all three of Mistral's Vibe entries on 2026-09-22
    // passed a word list pointed at their summaries.
    if (audience ? audience === "consumers" : !FOR_BUILDERS.test(text(record?.name) ?? "")) return "evidence";
  }
  return TOOL_CHANGELOGS.has(event.source) && !patchBuild(record) ? "release" : "evidence";
}
