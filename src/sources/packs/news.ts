import { collectAntigravityChangelog } from "../antigravity.js";
import { collectCursorChangelog } from "../community.js";
import { collectDeepSeekUpdates } from "../deepseek.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import {
  collectAnthropicSdkReleases,
  collectClaudeCodeChangelog,
  collectDeepMindBlog,
  collectGeminiAppBlog,
  collectGeminiModelsBlog,
  collectGoogleAiBlog,
  collectGoogleBlogIndia,
  collectGoogleBlogTaiwan,
  collectHuggingFaceBlogFeed,
  collectNvidiaDeveloperBlog,
  collectOpenAIAlignment,
  collectOpenAICodexChangelog,
  collectOpenAIDeploymentSafety,
  OPENAI_CODEX_CHANGELOG_FEED_URL,
} from "../feeds.js";
import { acceptedEtagUnchanged } from "../http.js";
import { collectJulesChangelog } from "../jules.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectLabPages, LAB_PAGE_SOURCES } from "../labPages.js";
import {
  collectAnthropicNews,
  collectAnthropicRoutes,
  collectClaudeBlog,
  collectHackerNews,
  collectOpenAINews,
} from "../news.js";
import { collectOpenAIDocsIndex, collectOpenAILearnIndex, collectOpenAIShowcaseIndex } from "../openaiDocs.js";
import { collectQwenBlog } from "../qwen.js";
import {
  collectGeminiApiChangelog,
  collectGroqChangelog,
  collectKimiCodeChangelog,
  collectMiniMaxCodeChangelog,
  collectMistralReleaseNotes,
  collectOpenAIApiChangelog,
  collectOpenAIChatGPTReleaseNotes,
  collectXaiReleaseNotes,
} from "../releaseNotes.js";
import { collectLabSitemap } from "../sitemaps.js";

/** A lab's own front page, and the one place other people's posts about them are read. */
const NEWSROOM: SourceKind = {
  kind: "newsroom",
  appendOnly: true,
  authority: "first_party",
  // The maker's own post about its own product. Supported rather than confirmed: an announcement is
  // the maker's word that something exists, and whether it can be called is a catalogue's business.
  evidence: "official_news",
  confidence: "supported",
  group: "Official news",
  stream: "news",
  // Where a launch is announced to everybody at once, so the quarter hour is the shortest pace
  // anything here is worth: the post is already public when the poll finds it.
  intervalSeconds: 900,
};

/** Research and product blogs, where a lab explains something it has already shipped. */
const LAB_BLOG: SourceKind = {
  kind: "lab-blog",
  appendOnly: true,
  authority: "first_party",
  // The maker's own post about its own product. Supported rather than confirmed: an announcement is
  // the maker's word that something exists, and whether it can be called is a catalogue's business.
  evidence: "official_news",
  confidence: "supported",
  group: "Official news",
  stream: "news",
  // Measured 2026-09-17: these answer 304 to a conditional request, or store only parsed entries,
  // so a poll that finds nothing costs no body and the database grows only when an entry does.
  intervalSeconds: 900,
};

/** Release notes and changelogs a lab publishes for its users rather than its developers. */
const RELEASE_NOTES: SourceKind = {
  kind: "release-notes",
  appendOnly: true,
  authority: "first_party",
  // The maker's own post about its own product. Supported rather than confirmed: an announcement is
  // the maker's word that something exists, and whether it can be called is a catalogue's business.
  evidence: "official_news",
  confidence: "supported",
  group: "Official news",
  stream: "news",
  intervalSeconds: 900,
};

/** API changelogs, SDK releases and the changelogs of the coding tools. */
const DEVELOPER_FEED: SourceKind = {
  kind: "developer-feed",
  appendOnly: true,
  authority: "first_party",
  // The maker's own post about its own product. Supported rather than confirmed: an announcement is
  // the maker's word that something exists, and whether it can be called is a catalogue's business.
  evidence: "official_news",
  confidence: "supported",
  group: "Official developer feeds",
  stream: "news",
  intervalSeconds: 1800,
};

/** Sitemaps, read for the launch page that is published before anything links to it. */
const SITEMAP: SourceKind = {
  kind: "sitemap",
  authority: "first_party",
  // A page that appeared, which is a maker preparing to say something rather than saying it.
  evidence: "github_activity",
  confidence: "observed",
  group: "Official news",
  stream: "github",
  // A launch page sits unlinked for hours, and these are multi-megabyte documents; half an hour is
  // enough. The small ones overrule this below, because the labs serving them announce there first.
  intervalSeconds: 1800,
};

/** Single pages from labs that post nowhere else read here, and Anthropic's own route table. */
const LAB_PAGE: SourceKind = {
  kind: "lab-page",
  authority: "first_party",
  // A page that appeared, which is a maker preparing to say something rather than saying it.
  evidence: "github_activity",
  confidence: "observed",
  group: "Official news",
  stream: "github",
  // Each a few kilobytes, from labs that post nowhere else read here.
  intervalSeconds: 600,
};

function newsroomSources({ cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(NEWSROOM, [
    // +45 MB of permanent high-water on the first read of its 1,230 items; see `heavy` in
    // src/poller.ts. Measured 2026-09-27.
    { id: "openai-news", vendor: "OpenAI", heavy: true, collector: () => collectOpenAINews() },
    // Five minutes rather than the newsroom's quarter hour, and it costs nothing: this page is the
    // one `anthropic-routes` reads below, on the same five minutes, and `SHARED_BODIES_MS` lets the
    // second of the pair read the body the first fetched. One document per round for both answers.
    {
      id: "anthropic-news",
      vendor: "Anthropic",
      intervalSeconds: 300,
      collector: () => collectAnthropicNews(fetch, new Date(), cache),
    },
    { id: "claude-blog", vendor: "Anthropic", collector: () => collectClaudeBlog(fetch, new Date(), cache) },
    // Not a newsroom and nobody's first party: other people writing about the labs, which is worth
    // the group it sits in and worth asking half as often.
    // A link aggregator repeating a maker's news is attention, not a second source for it, and it
    // observes no surface of its own -- so no evidence type fits and it never rises above observed.
    {
      id: "hackernews",
      authority: "third_party",
      evidence: "unknown",
      confidence: "observed",
      intervalSeconds: 1800,
      collector: () => collectHackerNews(),
    },
    // Cursor's changelog names the models it serves the day it serves them, so the post is the
    // product rather than an announcement about it.
    {
      id: "cursor-changelog",
      vendor: "Cursor",
      confidence: "confirmed",
      intervalSeconds: 1800,
      collector: () => collectCursorChangelog(),
    },
  ]);
}

function labBlogSources({ cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(LAB_BLOG, [
    { id: "google-ai-blog", vendor: "Google", collector: () => collectGoogleAiBlog(fetch, cache) },
    // Where a Gemini version is announced. Paced with the AI rubric it sits beside.
    { id: "gemini-models-blog", vendor: "Google", collector: () => collectGeminiModelsBlog(fetch, cache) },
    {
      id: "gemini-app-blog",
      vendor: "Google",
      intervalSeconds: 1800,
      collector: () => collectGeminiAppBlog(fetch, cache),
    },
    { id: "deepmind-blog", vendor: "Google", collector: () => collectDeepMindBlog(fetch, cache) },
    /**
     * Two regional blogs, kept only until they have answered whether a region publishes first.
     * See the note in ../feeds.ts: the Indian Argon article claims a `datePublished` twelve hours
     * before the announcement and a `dateModified` a day after it, and no read of ours was early
     * enough to say which of those was the page actually appearing. These two record our own
     * sighting against the publisher's, and `lead-time` settles it over the next announcements.
     */
    { id: "google-blog-in", vendor: "Google", collector: () => collectGoogleBlogIndia(fetch, cache) },
    { id: "google-blog-tw", vendor: "Google", collector: () => collectGoogleBlogTaiwan(fetch, cache) },
    {
      id: "openai-alignment",
      vendor: "OpenAI",
      intervalSeconds: 1800,
      collector: () => collectOpenAIAlignment(fetch, cache),
    },
    /**
     * The deployment safety hub, where a system card names the model it is about. A card is
     * published with the launch or ahead of it, so it is paced with the newsrooms rather than with
     * the blogs; the hub answers a conditional request, so a poll that finds nothing costs nothing.
     */
    {
      id: "openai-deployment-safety",
      vendor: "OpenAI",
      intervalSeconds: 900,
      collector: () => collectOpenAIDeploymentSafety(fetch, cache),
    },
    {
      id: "nvidia-developer-blog",
      vendor: "NVIDIA",
      intervalSeconds: 1800,
      collector: () => collectNvidiaDeveloperBlog(fetch, cache),
    },
  ]);
}

function releaseNoteSources({ db, config, cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(RELEASE_NOTES, [
    {
      id: "openai-chatgpt-release-notes",
      vendor: "OpenAI",
      collector: () => collectOpenAIChatGPTReleaseNotes(fetch, cache, { db, config }),
    },
    { id: "gemini-api-changelog", vendor: "Google", collector: () => collectGeminiApiChangelog(fetch, cache) },
    /**
     * Every Antigravity surface at once -- app, CLI, SDK and IDE -- as the Markdown the docs serve,
     * so no HTML is parsed for it. The CLI half is the coding client Google is moving to; the
     * manifest in the catalogues pack is faster, and this is what the release says.
     */
    {
      id: "antigravity-changelog",
      vendor: "Google",
      collector: () => collectAntigravityChangelog(fetch, cache),
    },
    /**
     * Jules, read as a lagging signal and documented as one in ../jules.ts: it says a model has
     * reached the coding product, months after the catalogue first named it. Hourly, because in
     * nine months it has moved model twice.
     */
    {
      id: "jules-changelog",
      vendor: "Google",
      intervalSeconds: 3600,
      collector: () => collectJulesChangelog(fetch, cache),
    },
    { id: "xai-release-notes", vendor: "xAI", collector: () => collectXaiReleaseNotes(fetch, cache) },
    {
      id: "mistral-release-notes",
      vendor: "Mistral",
      intervalSeconds: 3600,
      collector: () => collectMistralReleaseNotes(fetch, cache, { db, config }),
    },
    {
      id: "groq-changelog",
      vendor: "Groq",
      intervalSeconds: 1800,
      collector: () => collectGroqChangelog(fetch, cache),
    },
    {
      id: "deepseek-updates",
      vendor: "DeepSeek",
      intervalSeconds: 3600,
      collector: () => collectDeepSeekUpdates(fetch, cache),
    },
  ]);
}

function developerFeedSources({ db, cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(DEVELOPER_FEED, [
    // A 1.07 MB feed that claims +48 MB of permanent high-water the first time it is parsed: XML
    // becomes a tree an order of magnitude larger than its text. Measured 2026-09-27.
    /**
     * The Codex and ChatGPT changelog, which is where a reader who runs Codex hears first: the
     * `gpt-6.1-sol` entry was in this feed as "GPT-6.1 Sol in Codex and ChatGPT Work". It answers
     * 304 to a conditional request, measured 2026-09-29, so the half hour it used to wait bought
     * nothing -- a poll that finds nothing costs no body, and the 1.1 MB it costs when it does find
     * something is what `heavy` is for.
     */
    {
      id: "openai-codex-changelog",
      vendor: "OpenAI",
      heavy: true,
      // A minute, because the question is a HEAD with an if-none-match and the answer is 304: see
      // `acceptedEtagUnchanged`. The body is the 1.1 MB `heavy` exists for, and it is only ever
      // read after the cheap half has already said the feed moved.
      intervalSeconds: 60,
      nothingNew: () => acceptedEtagUnchanged(db, cache, "openai-codex-changelog", OPENAI_CODEX_CHANGELOG_FEED_URL),
      collector: () => collectOpenAICodexChangelog(fetch, cache),
    },
    /**
     * Answers 304 to a conditional request, measured 2026-09-17 and again 2026-09-29, so a poll
     * that finds nothing costs no body -- and the quarter hour this used to wait was the whole
     * margin of a race we lost. `gpt-6.1-sol`: the page went up at about 19:55 UTC on 2026-09-29,
     * another tracker published at 19:57, and this source read the page at 20:08 because that is
     * when its turn came round. Two minutes is the interval at which this page is the fastest
     * first-party surface there is: the model reached OpenAI's own catalogue at 20:11, the OpenAPI
     * spec at 20:16 and the announcement post at 21:16.
     */
    {
      id: "openai-api-changelog",
      vendor: "OpenAI",
      intervalSeconds: 120,
      collector: () => collectOpenAIApiChangelog(fetch, cache),
    },
    { id: "claude-code-changelog", vendor: "Anthropic", collector: () => collectClaudeCodeChangelog(fetch, cache) },
    {
      id: "anthropic-sdk-releases",
      vendor: "Anthropic",
      pace: { group: "discovery:docs-anthropic", seconds: 5 },
      collector: () => collectAnthropicSdkReleases(fetch, cache),
    },
    {
      id: "huggingface-blog-feed",
      authority: "vendor_owned",
      vendor: "Hugging Face",
      collector: () => collectHuggingFaceBlogFeed(fetch, cache),
    },
    { id: "kimi-code-changelog", vendor: "Moonshot", collector: () => collectKimiCodeChangelog(fetch, cache) },
    { id: "minimax-code-changelog", vendor: "MiniMax", collector: () => collectMiniMaxCodeChangelog(fetch, cache) },
  ]);
}

function sitemapSources(_context: SourceContext): SourceEntry[] {
  return sourcesOfKind(SITEMAP, [
    { id: "openai-sitemap", vendor: "OpenAI", collector: () => collectLabSitemap("openai-sitemap") },
    { id: "deepmind-sitemap", vendor: "Google", collector: () => collectLabSitemap("deepmind-sitemap") },
    {
      id: "anthropic-sitemap",
      vendor: "Anthropic",
      pace: { group: "discovery:docs-anthropic", seconds: 5 },
      collector: () => collectLabSitemap("anthropic-sitemap"),
    },
    // Small pages, and the labs that no feed here reads announce on them first.
    {
      id: "xiaomi-sitemap",
      vendor: "Xiaomi",
      intervalSeconds: 600,
      collector: () => collectLabSitemap("xiaomi-sitemap"),
    },
    { id: "zai-sitemap", vendor: "Z.ai", intervalSeconds: 600, collector: () => collectLabSitemap("zai-sitemap") },
    { id: "meta-blog", vendor: "Meta", intervalSeconds: 600, collector: () => collectLabSitemap("meta-blog") },
    {
      id: "deepseek-sitemap",
      vendor: "DeepSeek",
      intervalSeconds: 600,
      collector: () => collectLabSitemap("deepseek-sitemap"),
    },
  ]);
}

function labPageSources({ cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(LAB_PAGE, [
    /**
     * OpenAI's documentation index, kept for the guides that name a model. A model ships with its
     * guides -- "Upgrading to GPT-5.6 Sol" is a page of its own -- and the index carries the title
     * and the sentence under it, so a guide for a model nobody has announced reads like the model
     * page that answers before its launch.
     */
    {
      id: "openai-docs-index",
      vendor: "OpenAI",
      intervalSeconds: 300,
      pace: { group: "discovery:docs-openai", seconds: 5 },
      collector: () => collectOpenAIDocsIndex(fetch, cache),
    },
    /**
     * The other two indexes of the same site. A guide is written against the model that is current
     * when it is written and a showcase project is tagged with the model that built it, so both
     * name a model on the day a page is published rather than on the day it is announced. They sit
     * on the same host budget as the documentation index.
     */
    {
      id: "openai-learn-index",
      vendor: "OpenAI",
      intervalSeconds: 300,
      pace: { group: "discovery:docs-openai", seconds: 5 },
      collector: () => collectOpenAILearnIndex(fetch, cache),
    },
    {
      id: "openai-showcase-index",
      vendor: "OpenAI",
      intervalSeconds: 600,
      pace: { group: "discovery:docs-openai", seconds: 5 },
      collector: () => collectOpenAIShowcaseIndex(fetch, cache),
    },
    {
      id: "anthropic-routes",
      vendor: "Anthropic",
      // The Opus 5.5 slug was listed for hours, not days; a quarter hour could miss it.
      intervalSeconds: 300,
      collector: () => collectAnthropicRoutes(fetch, cache),
    },
    {
      id: "qwen-blog",
      vendor: "Qwen",
      // 4.78 MB of articles, read as bytes without allocating their texts. The child still
      // bounds its first-read claim, measured above 32 MB on 2026-10-04.
      heavy: true,
      collector: () => collectQwenBlog(),
    },
    ...Object.entries(LAB_PAGE_SOURCES).map(([id, vendor], index) => ({
      id,
      vendor,
      // Spread across the minute so the whole family does not land on one tick.
      intervalSeconds: LAB_PAGE.intervalSeconds + (index + 1) * 20,
      collector: () => collectLabPages(id as keyof typeof LAB_PAGE_SOURCES),
    })),
  ]);
}

/**
 * Official vendor newsrooms, blogs, changelogs and release notes.
 *
 * One list, assembled from the kinds of thing it is made of. Each kind says once what its members
 * share and why its pace is what it is; a member says only what differs, and overruling the pace is
 * how an exception stays visible as an exception. A source is added to the kind whose name describes
 * it, and a reader looking for why a sitemap is polled every ten minutes reads the kind.
 */
export function newsSources(context: SourceContext): SourceEntry[] {
  return [
    ...newsroomSources(context),
    ...labBlogSources(context),
    ...releaseNoteSources(context),
    ...developerFeedSources(context),
    ...sitemapSources(context),
    ...labPageSources(context),
  ];
}
