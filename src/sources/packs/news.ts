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

/** The newsrooms themselves: a lab's own front page, and the one place other people's posts about them are read. */
function newsroomSources(_context: SourceContext): SourceEntry[] {
  return [
    {
      id: "openai-news",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAINews(),
    },
    {
      id: "hackernews",
      authority: "third_party",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectHackerNews(),
    },
    {
      id: "anthropic-news",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectAnthropicNews(),
    },
    {
      id: "claude-blog",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectClaudeBlog(),
    },
    {
      id: "cursor-changelog",
      authority: "first_party",
      vendor: "Cursor",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectCursorChangelog(),
    },
  ];
}

/** Research and product blogs, where a lab explains something it has already shipped. */
function labBlogSources({ cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "google-ai-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectGoogleAiBlog(fetch, cache),
    },
    {
      id: "gemini-models-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // Where a Gemini version is announced. Paced with the AI rubric it sits beside.
      intervalSeconds: 900,
      collector: () => collectGeminiModelsBlog(fetch, cache),
    },
    {
      id: "gemini-app-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectGeminiAppBlog(fetch, cache),
    },
    {
      id: "deepmind-blog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // Answers 304 to a conditional request, measured 2026-09-17, so a poll that finds nothing costs no body.
      intervalSeconds: 900,
      collector: () => collectDeepMindBlog(fetch, cache),
    },
    {
      id: "openai-alignment",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAIAlignment(fetch, cache),
    },
    {
      id: "nvidia-developer-blog",
      authority: "first_party",
      vendor: "NVIDIA",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectNvidiaDeveloperBlog(fetch, cache),
    },
  ];
}

/** Release notes and changelogs a lab publishes for its users rather than its developers. */
function releaseNoteSources({ db, config, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "openai-chatgpt-release-notes",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "news",
      intervalSeconds: 900,
      collector: () => collectOpenAIChatGPTReleaseNotes(fetch, cache, { db, config }),
    },
    {
      id: "gemini-api-changelog",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectGeminiApiChangelog(fetch, cache),
    },
    {
      id: "xai-release-notes",
      authority: "first_party",
      vendor: "xAI",
      group: "Official news",
      stream: "news",
      // No validator, measured 2026-09-17; the stored snapshot is the parsed entries, so the database grows
      // only when an entry does.
      intervalSeconds: 900,
      collector: () => collectXaiReleaseNotes(fetch, cache),
    },
    {
      id: "mistral-release-notes",
      authority: "first_party",
      vendor: "Mistral",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectMistralReleaseNotes(fetch, cache, { db, config }),
    },
    {
      id: "groq-changelog",
      authority: "first_party",
      vendor: "Groq",
      group: "Official news",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectGroqChangelog(fetch, cache),
    },
    {
      id: "deepseek-updates",
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Official news",
      stream: "news",
      intervalSeconds: 3600,
      collector: () => collectDeepSeekUpdates(fetch, cache),
    },
  ];
}

/** The `Official developer feeds` group: API changelogs, SDK releases and the changelogs of the coding tools. */
function developerFeedSources({ cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "openai-codex-changelog",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectOpenAICodexChangelog(fetch, cache),
    },
    {
      id: "openai-api-changelog",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official developer feeds",
      stream: "news",
      // Answers 304 to a conditional request, measured 2026-09-17, so a poll that finds nothing costs no body.
      intervalSeconds: 900,
      collector: () => collectOpenAIApiChangelog(fetch, cache),
    },
    {
      id: "claude-code-changelog",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectClaudeCodeChangelog(fetch, cache),
    },
    {
      id: "anthropic-sdk-releases",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectAnthropicSdkReleases(fetch, cache),
    },
    {
      id: "huggingface-blog-feed",
      authority: "vendor_owned",
      vendor: "Hugging Face",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectHuggingFaceBlogFeed(fetch, cache),
    },
    {
      id: "kimi-code-changelog",
      authority: "first_party",
      vendor: "Moonshot",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectKimiCodeChangelog(fetch, cache),
    },
    {
      id: "minimax-code-changelog",
      authority: "first_party",
      vendor: "MiniMax",
      group: "Official developer feeds",
      stream: "news",
      intervalSeconds: 1800,
      collector: () => collectMiniMaxCodeChangelog(fetch, cache),
    },
  ];
}

/** Sitemaps, read for the launch page that is published before anything links to it. */
function sitemapSources(_context: SourceContext): SourceEntry[] {
  return [
    {
      id: "openai-sitemap",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Official news",
      stream: "github",
      // A launch page sits unlinked for hours; half an hour of a multi-megabyte sitemap is enough.
      intervalSeconds: 1800,
      collector: () => collectLabSitemap("openai-sitemap"),
    },
    {
      id: "deepmind-sitemap",
      authority: "first_party",
      vendor: "Google",
      group: "Official news",
      stream: "github",
      // A launch page sits unlinked for hours; half an hour of a multi-megabyte sitemap is enough.
      intervalSeconds: 1800,
      collector: () => collectLabSitemap("deepmind-sitemap"),
    },
    {
      id: "anthropic-sitemap",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "github",
      // A launch page sits unlinked for hours; half an hour of a multi-megabyte sitemap is enough.
      intervalSeconds: 1800,
      collector: () => collectLabSitemap("anthropic-sitemap"),
    },
    {
      id: "xiaomi-sitemap",
      authority: "first_party",
      vendor: "Xiaomi",
      group: "Official news",
      stream: "github",
      // A small page, and the labs that no feed here reads announce on it first.
      intervalSeconds: 600,
      collector: () => collectLabSitemap("xiaomi-sitemap"),
    },
    {
      id: "zai-sitemap",
      authority: "first_party",
      vendor: "Z.ai",
      group: "Official news",
      stream: "github",
      // A small page, and the labs that no feed here reads announce on it first.
      intervalSeconds: 600,
      collector: () => collectLabSitemap("zai-sitemap"),
    },
    {
      id: "meta-blog",
      authority: "first_party",
      vendor: "Meta",
      group: "Official news",
      stream: "github",
      // A small page, and the labs that no feed here reads announce on it first.
      intervalSeconds: 600,
      collector: () => collectLabSitemap("meta-blog"),
    },
    {
      id: "deepseek-sitemap",
      authority: "first_party",
      vendor: "DeepSeek",
      group: "Official news",
      stream: "github",
      intervalSeconds: 600,
      collector: () => collectLabSitemap("deepseek-sitemap"),
    },
  ];
}

/** Single pages from labs that post nowhere else read here, and Anthropic's own route table. */
function labPageSources(_context: SourceContext): SourceEntry[] {
  return [
    {
      id: "anthropic-routes",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Official news",
      stream: "github",
      // The Opus 5.5 slug was listed for hours, not days; the newsroom's quarter hour could miss it.
      intervalSeconds: 300,
      collector: () => collectAnthropicRoutes(),
    },
    ...Object.entries(LAB_PAGE_SOURCES).map(
      ([id, vendor], index): SourceEntry => ({
        id,
        authority: "first_party",
        vendor,
        group: "Official news",
        stream: "github",
        // Each a few kilobytes, from labs that post nowhere else read here.
        intervalSeconds: 600 + index * 20,
        collector: () => collectLabPages(id as keyof typeof LAB_PAGE_SOURCES),
      }),
    ),
  ];
}

/**
 * Official vendor newsrooms, blogs, changelogs and release notes.
 *
 * One list, assembled from the kinds of thing it is made of. A source is added to the function whose
 * name describes it, and a reader looking for why a sitemap is polled every ten minutes reads twenty
 * lines rather than three hundred.
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
