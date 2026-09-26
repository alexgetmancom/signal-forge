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
  collectHuggingFaceBlogFeed,
  collectNvidiaDeveloperBlog,
  collectOpenAIAlignment,
  collectOpenAICodexChangelog,
} from "../feeds.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectLabPages, LAB_PAGE_SOURCES } from "../labPages.js";
import {
  collectAnthropicNews,
  collectAnthropicRoutes,
  collectClaudeBlog,
  collectHackerNews,
  collectOpenAINews,
} from "../news.js";
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
  authority: "first_party",
  group: "Official news",
  stream: "news",
  // Where a launch is announced to everybody at once, so the quarter hour is the shortest pace
  // anything here is worth: the post is already public when the poll finds it.
  intervalSeconds: 900,
};

/** Research and product blogs, where a lab explains something it has already shipped. */
const LAB_BLOG: SourceKind = {
  kind: "lab-blog",
  authority: "first_party",
  group: "Official news",
  stream: "news",
  // Measured 2026-09-17: these answer 304 to a conditional request, or store only parsed entries,
  // so a poll that finds nothing costs no body and the database grows only when an entry does.
  intervalSeconds: 900,
};

/** Release notes and changelogs a lab publishes for its users rather than its developers. */
const RELEASE_NOTES: SourceKind = {
  kind: "release-notes",
  authority: "first_party",
  group: "Official news",
  stream: "news",
  intervalSeconds: 900,
};

/** API changelogs, SDK releases and the changelogs of the coding tools. */
const DEVELOPER_FEED: SourceKind = {
  kind: "developer-feed",
  authority: "first_party",
  group: "Official developer feeds",
  stream: "news",
  intervalSeconds: 1800,
};

/** Sitemaps, read for the launch page that is published before anything links to it. */
const SITEMAP: SourceKind = {
  kind: "sitemap",
  authority: "first_party",
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
  group: "Official news",
  stream: "github",
  // Each a few kilobytes, from labs that post nowhere else read here.
  intervalSeconds: 600,
};

function newsroomSources(_context: SourceContext): SourceEntry[] {
  return sourcesOfKind(NEWSROOM, [
    { id: "openai-news", vendor: "OpenAI", collector: () => collectOpenAINews() },
    { id: "anthropic-news", vendor: "Anthropic", collector: () => collectAnthropicNews() },
    { id: "claude-blog", vendor: "Anthropic", collector: () => collectClaudeBlog() },
    // Not a newsroom and nobody's first party: other people writing about the labs, which is worth
    // the group it sits in and worth asking half as often.
    { id: "hackernews", authority: "third_party", intervalSeconds: 1800, collector: () => collectHackerNews() },
    { id: "cursor-changelog", vendor: "Cursor", intervalSeconds: 1800, collector: () => collectCursorChangelog() },
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
    {
      id: "openai-alignment",
      vendor: "OpenAI",
      intervalSeconds: 1800,
      collector: () => collectOpenAIAlignment(fetch, cache),
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

function developerFeedSources({ cache }: SourceContext): SourceEntry[] {
  return sourcesOfKind(DEVELOPER_FEED, [
    { id: "openai-codex-changelog", vendor: "OpenAI", collector: () => collectOpenAICodexChangelog(fetch, cache) },
    // Answers 304 to a conditional request, measured 2026-09-17, so a poll that finds nothing costs no body.
    {
      id: "openai-api-changelog",
      vendor: "OpenAI",
      intervalSeconds: 900,
      collector: () => collectOpenAIApiChangelog(fetch, cache),
    },
    { id: "claude-code-changelog", vendor: "Anthropic", collector: () => collectClaudeCodeChangelog(fetch, cache) },
    { id: "anthropic-sdk-releases", vendor: "Anthropic", collector: () => collectAnthropicSdkReleases(fetch, cache) },
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
    { id: "anthropic-sitemap", vendor: "Anthropic", collector: () => collectLabSitemap("anthropic-sitemap") },
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

function labPageSources(_context: SourceContext): SourceEntry[] {
  return sourcesOfKind(LAB_PAGE, [
    {
      id: "anthropic-routes",
      vendor: "Anthropic",
      // The Opus 5.5 slug was listed for hours, not days; the newsroom's quarter hour could miss it.
      intervalSeconds: 300,
      collector: () => collectAnthropicRoutes(),
    },
    ...Object.entries(LAB_PAGE_SOURCES).map(([id, vendor], index) => ({
      id,
      vendor,
      // Spread across the minute so the whole family does not land on one tick.
      intervalSeconds: LAB_PAGE.intervalSeconds + index * 20,
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
