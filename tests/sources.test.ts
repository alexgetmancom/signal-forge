import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { selectMeaningfulWebStrings } from "../src/events/web.js";
import { saveCollection } from "../src/events.js";
import { parseArena, parseLeaderboards } from "../src/sources/arena.js";
import { collectAnthropic, collectOpenRouter } from "../src/sources/catalogs.js";
import { claudeAssetImports, extractStrings } from "../src/sources/claude.js";
import { parseCursorChangelog, parseDesignArena } from "../src/sources/community.js";
import { parseDeepSeekPricing, parseDeepSeekUpdates } from "../src/sources/deepseek.js";
import { parseAnthropicDeprecations, parseOpenAIDeprecations } from "../src/sources/deprecations.js";
import { parseAnthropicSdkReleases, parseClaudeCodeChangelog, parseOfficialFeed } from "../src/sources/feeds.js";
import { collectGithubCommits, summarizeDiff } from "../src/sources/github.js";
import { fetchText, SourceHttpError } from "../src/sources/http.js";
import {
  parseAwsBedrockLifecycle,
  parseAzureFoundryLifecycle,
  parseCohereDeprecations,
  parseGeminiDeprecations,
  parseGroqDeprecations,
  parseVertexDeprecations,
  parseXaiDeprecations,
} from "../src/sources/lifecycle.js";
import { parseAnthropicNews, parseOpenAINews } from "../src/sources/news.js";
import { collectHuggingFace, parseHuggingFace, parseNpm } from "../src/sources/registries.js";
import {
  collectOpenAIChatGPTReleaseNotes,
  parseGeminiApiChangelog,
  parseGroqChangelog,
  parseMistralReleaseNotes,
  parseOpenAIChatGPTReleaseNotes,
  parseXaiReleaseNotes,
} from "../src/sources/releaseNotes.js";
import { openDatabase } from "../src/storage/database.js";
import { freshUntil, HttpCache } from "../src/storage/httpCache.js";

function nextPage(value: unknown): string {
  return `<script>self.__next_f.push(${JSON.stringify([1, `1:${JSON.stringify(value)}\n`])})</script>`;
}
test("Arena accepts models without internal name but requires valid public fields", () => {
  const model = {
    id: "one",
    displayName: "Public",
    userSelectable: false,
    capabilities: { inputCapabilities: { text: true }, outputCapabilities: { text: true } },
  };
  expect(parseArena(nextPage({ initialModels: [model] })).records[0]?.model).toBe("Public");
  expect(() => parseArena("<html>Challenge</html>")).toThrow("no longer exposes");
  expect(() => parseArena(nextPage({ initialModels: [{ id: "one" }] }))).toThrow();
});
test("leaderboard keeps rank for the leading places and drops it below them", () => {
  const board = {
    arenaSlug: "text",
    leaderboardSlug: "overall",
    entries: [
      {
        modelKey: "a",
        modelDisplayName: "A",
        modelOrganization: "Maker",
        rank: 1,
        rating: 1400.25,
        votes: 123,
        modelUrl: "https://example.test/model",
      },
      { modelKey: "z", modelDisplayName: "Z", modelOrganization: "Maker", rank: 44 },
    ],
  };
  const parsed = parseLeaderboards(nextPage({ leaderboards: [board] }));
  expect(parsed.appendOnly).toBeUndefined();
  expect(parsed.records[0]).toMatchObject({ id: "text:overall:a", rank: 1, score: 1400.25, votes: 123, modelKey: "a" });
  // Deep in a board the order churns daily; storing it would buy events and no news.
  expect(parsed.records[1]).not.toHaveProperty("rank");
});
test("leaderboard preserves dynamic agent metrics as a keyed object", () => {
  const board = {
    arenaSlug: "agent",
    leaderboardSlug: "overall",
    entries: [
      {
        modelKey: "agent-a",
        modelDisplayName: "Agent A",
        modelOrganization: "Maker",
        rank: 1,
        rating: 1400,
        steerability: 0.8,
        recovery: 0.7,
        metrics: { tool_hallucination: 0.1 },
      },
    ],
  };
  expect(parseLeaderboards(nextPage({ leaderboards: [board] })).records[0]).toMatchObject({
    metrics: { recovery: 0.7, steerability: 0.8, tool_hallucination: 0.1 },
  });
});
test("RSS parses escaped titles and preserves article dates", () => {
  const c = parseOpenAINews(
    "<rss><channel><item><title>Codex &amp; tools</title><link>https://openai.com/index/codex</link><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>",
  );
  expect(c.records[0]?.name).toBe("Codex & tools");
  expect(c.records[0]?.published).toBe("2026-09-07T10:00:00.000Z");
  expect(() => parseOpenAINews("<html>unavailable</html>")).toThrow();
});
test("Anthropic newsroom parser keeps official title, category and date", () => {
  const html = `<ul><li><a href="/news/new-model" class="item"><div><time class="date">Sep 1, 2026</time><span class="subject">Product</span></div><span class="title">Claude &amp; tools</span></a></li></ul>`;
  const c = parseAnthropicNews(html);
  expect(c.records).toEqual([
    {
      id: "https://www.anthropic.com/news/new-model",
      name: "Claude & tools",
      url: "https://www.anthropic.com/news/new-model",
      category: "Product",
      published: "2026-09-01T00:00:00.000Z",
    },
  ]);
  expect(() => parseAnthropicNews("<html>unavailable</html>")).toThrow("not found");
});
test("DeepSeek changelog parser keeps dated official updates and rejects an empty page", () => {
  const html = `<article>
    <h2 id="date-2026-08-21">Date: 2026-08-21<a href="#date-2026-08-21">​</a></h2>
    <h3 id="deepseek-v4-flash-vision-exp-release">DeepSeek-V4-Flash-Vision-Exp Release<a>​</a></h3>
    <p>Today, the new vision model is now available on the DeepSeek API platform.</p>
    <h2 id="date-2026-08-13">Date: 2026-08-13<a>​</a></h2>
    <h3 id="deepseek-v4-pro-update">DeepSeek-V4-Pro Update</h3>
    <p>The GA release has been rolled out on the API.</p>
  </article>`;
  const parsed = parseDeepSeekUpdates(html);
  expect(parsed).toMatchObject({ source: "deepseek-updates", stream: "news", appendOnly: true, trackChanges: true });
  expect(parsed.records).toEqual([
    expect.objectContaining({
      id: "2026-08-21:deepseek-v4-flash-vision-exp-release",
      name: "DeepSeek-V4-Flash-Vision-Exp Release",
      url: "https://api-docs.deepseek.com/updates#deepseek-v4-flash-vision-exp-release",
      published: "2026-08-21T00:00:00.000Z",
      maker: "DeepSeek",
    }),
    expect.objectContaining({ id: "2026-08-13:deepseek-v4-pro-update", name: "DeepSeek-V4-Pro Update" }),
  ]);
  expect(parsed.records[0]?.summary).toContain("vision model");
  expect(() => parseDeepSeekUpdates("<article><h2>Date: 2026-08-21</h2></article>")).toThrow();
});
test("DeepSeek pricing parser preserves model versions, capabilities and price windows", () => {
  const html = `<table>
    <tr><td colspan="3">MODEL</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
    <tr><td colspan="3">MODEL VERSION</td><td>DeepSeek-V4-Flash-0731</td><td>DeepSeek-V4-Pro-0813</td></tr>
    <tr><td colspan="3">CONTEXT LENGTH</td><td colspan="2">1M</td></tr>
    <tr><td colspan="3">MAX OUTPUT</td><td colspan="2">MAXIMUM: 384K</td></tr>
    <tr><td rowspan="2">FEATURES</td><td colspan="2">Tool Calls</td><td>✓</td><td>✓</td></tr>
    <tr><td rowspan="2">PRICING</td><td>1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.007</td><td>$0.022</td></tr>
    <tr><td>PEAK</td><td>$0.014</td><td>$0.044</td></tr>
    <tr><td colspan="3">Concurrency Limit</td><td>2500</td><td>500</td></tr>
  </table>`;
  const parsed = parseDeepSeekPricing(html);
  expect(parsed).toMatchObject({ source: "deepseek-pricing", stream: "api-models", confirmChanges: true });
  expect(parsed.records[0]).toMatchObject({
    id: "deepseek-v4-flash",
    modelVersion: "DeepSeek-V4-Flash-0731",
    context: "1M",
    capabilities: ["Tool Calls"],
    pricing: { inputCacheHitOffPeak: 0.007, inputCacheHitPeak: 0.014 },
    concurrencyLimit: 2500,
  });
  expect(() => parseDeepSeekPricing("<table><tr><td>MODEL</td></tr></table>")).toThrow();
});
test("official release-note pages keep dated entries and reject unreadable pages", async () => {
  const openaiHtml = `<article>
    <h1>ChatGPT — Release Notes</h1>
    <h1><b>September 9, 2026</b></h1>
    <h2><b>Updated models and usage limits in ChatGPT Voice</b></h2>
    <p>Voice can now use newer reasoning models.</p>
    <h2><b>Another ChatGPT update</b></h2>
    <ul><li>More controls are available.</li></ul>
    <h1>September 3, 2026</h1>
    <h2>Introducing GPT-6 Astra</h2>
    <p>A new model is available.</p>
  </article>`;
  const openai = parseOpenAIChatGPTReleaseNotes(openaiHtml);
  expect(openai.records).toEqual([
    expect.objectContaining({
      id: "2026-09-09:updated-models-and-usage-limits-in-chatgpt-voice",
      name: "Updated models and usage limits in ChatGPT Voice",
      url: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
      published: "2026-09-09T00:00:00.000Z",
    }),
    expect.objectContaining({ id: "2026-09-09:another-chatgpt-update" }),
    expect.objectContaining({ id: "2026-09-03:introducing-gpt-6-astra" }),
  ]);
  expect(openai.records[0]?.summary).toContain("newer reasoning models");
  expect(openai.appendOnly).toBe(true);
  await collectOpenAIChatGPTReleaseNotes(async (url) => {
    expect(String(url)).toBe("https://help.openai.com/en/articles/6825453-chatgpt-release-notes.json");
    return new Response(openaiHtml);
  });
  expect(() => parseOpenAIChatGPTReleaseNotes("<html>blocked</html>")).toThrow("article not found");

  const gemini = parseGeminiApiChangelog(
    `<main><h1>Changelog</h1>
      <h2 id="09-03-2026" data-text="September 3, 2026">September 3, 2026</h2>
      <p>Gemini API added a new capability.</p>
      <h2 id="09-02-2026" data-text="September 2, 2026">September 2, 2026</h2>
      <p>Gemini API improved reliability.</p>
    </main>`,
  );
  expect(gemini.records).toEqual([
    expect.objectContaining({
      id: "2026-09-03",
      name: "Gemini API changelog · 2026-09-03",
      url: "https://ai.google.dev/gemini-api/docs/changelog#09-03-2026",
      published: "2026-09-03T00:00:00.000Z",
    }),
    expect.objectContaining({ id: "2026-09-02" }),
  ]);
  expect(gemini.records[0]?.summary).toContain("new capability");

  const xai = parseXaiReleaseNotes(
    `<main><h1>Release notes</h1><p>Last updated: September 2, 2026</p>
      <h2 id="september"><a>September</a></h2>
      <div class="text-muted top-bar"><div class="relative">September 2<span aria-hidden="true"></span></div></div>
      <div><h3 id="grok-46"><a>Grok 4.6</a></h3><p>Grok 4.6 is available in the API.</p></div>
      <h2 id="september-2025"><a>September 2025</a></h2>
      <div class="text-muted top-bar"><div class="relative">Sep 15<span aria-hidden="true"></span></div></div>
      <div><h3 id="older-entry"><a>Older entry</a></h3><p>Older API update.</p></div>
    </main>`,
  );
  expect(xai.records).toEqual([
    expect.objectContaining({
      id: "2026-09-02:grok-46",
      name: "Grok 4.6",
      url: "https://docs.x.ai/developers/release-notes#grok-46",
      published: "2026-09-02T00:00:00.000Z",
    }),
    expect.objectContaining({ id: "2025-09-15:older-entry", published: "2025-09-15T00:00:00.000Z" }),
  ]);
  expect(xai.records[0]?.summary).toContain("available in the API");

  const mistral = parseMistralReleaseNotes(
    `<main><h1>Release notes</h1>
      <time dateTime="2026-08-20">Aug 20, 2026</time><h2>API key expiration policies</h2><p>Keys now expire.</p>
      <time dateTime="2026-07-31">Jul 31, 2026</time><h2>Workflow search</h2><p>Search is improved.</p>
    </main>`,
  );
  expect(mistral.records).toEqual([
    expect.objectContaining({
      id: "2026-08-20:api-key-expiration-policies",
      name: "API key expiration policies",
      published: "2026-08-20T00:00:00.000Z",
    }),
    expect.objectContaining({ id: "2026-07-31:workflow-search" }),
  ]);

  const groq = parseGroqChangelog(
    `<p>Current page data: 2026-04-18.</p>
      <span class="text-xs sticky top-0">Apr 18</span>
      <h3 id="new-model" class="first:mt-0 mt-12"><span>Added</span><a href="#new-model">New model</a></h3>
      <p>A new model is available.</p>
      <span class="text-xs sticky top-0">Dec 1, 2025</span>
      <h3 id="old-model" class="first:mt-0 mt-12"><span>Changed</span><a href="#old-model">Old model</a></h3>
      <ul><li>Pricing changed.</li></ul>
      <h3 id="looking-for-older-changelogs" class="mt-8"><a>Looking for older changelogs</a></h3>`,
  );
  expect(groq.records).toEqual([
    expect.objectContaining({ id: "2026-04-18:new-model", name: "New model", published: "2026-04-18T00:00:00.000Z" }),
    expect.objectContaining({ id: "2025-12-01:old-model", name: "Old model" }),
  ]);
  expect(groq.records[1]?.summary).toContain("Pricing changed");
});
test("Hugging Face retains useful model metadata without turning it into change events", () => {
  const parsed = parseHuggingFace(
    JSON.stringify([
      {
        id: "deepseek-ai/DeepSeek-V4",
        author: "deepseek-ai",
        createdAt: "2026-04-24T00:00:00.000Z",
        lastModified: "2026-08-21T00:00:00.000Z",
        likes: 1200,
        downloads: 340000,
        pipeline_tag: "text-generation",
        library_name: "transformers",
        tags: ["deepseek", "text-generation"],
        gated: false,
      },
    ]),
    "deepseek-ai",
  );
  expect(parsed.records[0]).toMatchObject({
    modified: "2026-08-21T00:00:00.000Z",
    likes: 1200,
    downloads: 340000,
    tags: ["deepseek", "text-generation"],
    pipeline: "text-generation",
  });
  expect(parsed.appendOnly).toBe(true);
  expect(parsed.trackChanges).toBeUndefined();
});
test("lifecycle parsers retain dates, replacements and regional context", () => {
  const gemini = parseGeminiDeprecations(
    `<table><tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr>
      <tr><td>gemini-2.0-flash</td><td>February 5, 2025</td><td>June 1, 2026</td><td>gemini-3.5-flash</td></tr></table>`,
  );
  expect(gemini.records[0]).toMatchObject({
    modelId: "gemini-2.0-flash",
    retirement: "June 1, 2026",
    replacement: "gemini-3.5-flash",
  });

  const aws = parseAwsBedrockLifecycle(
    `<table><tr><th>Model provider</th><th>Model name</th><th>Model ID</th><th>Regions</th><th>Legacy date</th><th>EOL date</th></tr>
      <tr><td>Anthropic</td><td>Claude</td><td>anthropic.claude-v1</td><td>us-east-1, eu-west-1</td><td>April 1, 2026</td><td>October 1, 2026</td></tr></table>`,
  );
  expect(aws.records[0]).toMatchObject({
    modelId: "anthropic.claude-v1",
    region: "us-east-1, eu-west-1",
    retirement: "October 1, 2026",
  });

  const azure = parseAzureFoundryLifecycle(
    `<table><tr><th>Model</th><th>Version</th><th>Lifecycle</th><th>Retirement date</th><th>Replacement</th></tr>
      <tr><td>gpt-4o</td><td>2024-05-13</td><td>Deprecated</td><td>2026-10-01</td><td>gpt-5.1</td></tr></table>`,
  );
  expect(azure.records[0]).toMatchObject({ stage: "Deprecated", retirement: "2026-10-01", replacement: "gpt-5.1" });

  const tables = `<table><tr><th>Deprecated Model</th><th>Shutdown Date</th><th>Recommended Replacement Model ID</th></tr>
    <tr><td>old-model</td><td>08/16/26</td><td>new-model</td></tr></table>`;
  expect(parseGroqDeprecations(tables).records[0]).toMatchObject({ modelId: "old-model", replacement: "new-model" });
  expect(parseCohereDeprecations(tables).records[0]).toMatchObject({ maker: "Cohere" });
  expect(
    parseXaiDeprecations(
      `<table><tr><th>Model being retired</th><th>Redirect target after May 15</th></tr><tr><td>grok-3</td><td>grok-4.3</td></tr></table>`,
    ).records[0],
  ).toMatchObject({ modelId: "grok-3", replacement: "grok-4.3" });
  expect(
    parseVertexDeprecations(
      `<table><tr><th>Discontinued endpoints</th><th>Recommended endpoint migration</th></tr><tr><td>veo-old</td><td>veo-new</td></tr></table>`,
    ).records[0],
  ).toMatchObject({ modelId: "veo-old", replacement: "veo-new" });
});

test("lifecycle parsers preserve active stages instead of labelling every row deprecated", () => {
  const gemini = parseGeminiDeprecations(
    `<h2>Gemini models</h2><table>
      <tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr>
      <tr><td>gemini-live</td><td>September 1, 2026</td><td>No shutdown date announced</td><td>—</td></tr>
      <tr><td colspan="4">Preview models</td></tr>
      <tr><td>gemini-preview</td><td>August 1, 2026</td><td>December 1, 2026</td><td>gemini-live</td></tr>
    </table>`,
  );
  expect(gemini.records).toEqual([
    expect.objectContaining({ modelId: "gemini-live", stage: "Active", deprecated: null, retirement: null }),
    expect.objectContaining({
      modelId: "gemini-preview",
      stage: "Preview",
      deprecated: null,
      retirement: "December 1, 2026",
      replacement: "gemini-live",
    }),
  ]);

  const azure = parseAzureFoundryLifecycle(
    `<table><tr><th>Model</th><th>Version</th><th>Lifecycle</th><th>Retirement date</th><th>Replacement</th></tr>
      <tr><td>gpt-5</td><td>1</td><td>GA</td><td>—</td><td>—</td></tr>
      <tr><td>gpt-4</td><td>1</td><td>Deprecated</td><td>2026-10-01</td><td>gpt-5</td></tr></table>`,
  );
  expect(azure.records).toEqual([
    expect.objectContaining({ modelId: "gpt-5", version: "1", stage: "GA", deprecated: null, retirement: null }),
    expect.objectContaining({ modelId: "gpt-4", version: "1", stage: "Deprecated", deprecated: null }),
  ]);

  const xai = parseXaiDeprecations(
    `<p>Retirement is effective May 15, 2026.</p><table><tr><th>Model being retired</th><th>Redirect target after May 15</th></tr>
      <tr><td>grok-old</td><td>grok-new</td></tr></table>`,
  );
  expect(xai.records[0]).toMatchObject({ stage: "Retired", retirement: "May 15, 2026", deprecated: null });
});

test("official developer feeds validate RSS and Atom and retain tool release evidence", () => {
  const rss = parseOfficialFeed(
    `<rss version="2.0"><channel><item><title>Codex skill update</title><link>https://example.test/codex</link><description>New skill</description><pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    { source: "feed-test", maker: "OpenAI", url: "https://example.test/feed.xml" },
  );
  expect(rss.records[0]).toMatchObject({ name: "Codex skill update", published: "2026-09-09T10:00:00.000Z" });
  const atom = parseOfficialFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>CUDA AI</title><link rel="alternate" href="https://example.test/atom"/><id>x</id><updated>2026-09-09T10:00:00Z</updated><summary>GPU model</summary></entry></feed>`,
    { source: "atom-test", maker: "NVIDIA", url: "https://example.test/feed.atom" },
  );
  expect(atom.records[0]?.url).toBe("https://example.test/atom");
  expect(() =>
    parseOfficialFeed("<html>error</html>", { source: "feed-test", maker: "OpenAI", url: "https://example.test" }),
  ).toThrow();

  const claude = parseClaudeCodeChangelog(
    `<Update label="2.1.267" description="September 9, 2026">* Added <code>skills</code></Update>`,
  );
  expect(claude.records[0]).toMatchObject({ version: "2.1.267", published: "2026-09-09T00:00:00.000Z" });
  const sdk = parseAnthropicSdkReleases("### September 3, 2026\n\n* Added a new SDK method.");
  expect(sdk.records[0]).toMatchObject({ maker: "Anthropic", published: "2026-09-03T00:00:00.000Z" });
});
test("Claude extraction decodes strings without executing source", () => {
  expect(
    extractStrings(
      'throw Error("never run");const a={defaultMessage:"Hello\\nworld"};x({defaultMessage:"Hello\\nworld"})',
    ),
  ).toEqual(["Hello\nworld"]);
});
test("Claude web keeps normalized product strings and drops interface boilerplate", () => {
  expect(
    selectMeaningfulWebStrings([
      "Open in new tab",
      "  Claude Code can open a remote worktree  ",
      "A model can use an API connector",
      "Loading",
    ]),
  ).toEqual(["A model can use an API connector", "Claude Code can open a remote worktree"]);
});
test("Claude asset discovery follows static and dynamic relative imports", () => {
  expect(
    claudeAssetImports(
      'import x from "./one.js";const y=import("../two.js");import("https://example.com/no.js")',
      "https://assets-proxy.anthropic.com/claude-ai/app/chunks/main.js",
    ),
  ).toEqual([
    "https://assets-proxy.anthropic.com/claude-ai/app/chunks/one.js",
    "https://assets-proxy.anthropic.com/claude-ai/app/two.js",
  ]);
});
test("OpenRouter schema rejects error pages and normalizes modality ordering", async () => {
  const data = {
    data: [
      {
        id: "a",
        name: "A",
        created: 1,
        context_length: 100,
        pricing: { prompt: "0" },
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      },
    ],
  };
  const c = await collectOpenRouter(async () => Response.json(data));
  expect(c.records[0]?.input).toEqual(["image", "text"]);
  await expect(collectOpenRouter(async () => Response.json({ error: "unavailable" }))).rejects.toThrow();
});
test("Anthropic collects all pages, never treating first page as entire catalog", async () => {
  let n = 0;
  const c = await collectAnthropic(
    loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname }),
    async (url) => {
      n++;
      if (n === 2) expect(url).toContain("after_id=a");
      return Response.json({
        data: [{ id: n === 1 ? "a" : "b", display_name: "Model", created_at: "2026-01-01" }],
        has_more: n === 1,
        last_id: n === 1 ? "a" : "b",
      });
    },
  );
  expect(c.records.map((r) => r.id)).toEqual(["a", "b"]);
});
test("diff excludes lockfiles and caps file count and excerpts", () => {
  const files = [
    { filename: "docs/bun.lock", status: "modified", additions: 1, deletions: 0, patch: "+noise" },
    {
      filename: "docs/feature.md",
      status: "modified",
      additions: 50,
      deletions: 0,
      patch: Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n"),
    },
  ];
  const result = summarizeDiff(files, ["docs/"]);
  expect(result).not.toContain("noise");
  expect(result).toContain("line 7");
  expect(result).not.toContain("line 8");
  expect(result).toContain("truncated");
});
test("GitHub catches up oldest first without skipping the next batch", async () => {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const watch = config.github[0];
  if (!watch) throw new Error("Missing fixture watch");
  const commits = Array.from({ length: 13 }, (_, i) => ({
    sha: String(13 - i).padStart(40, "0"),
    html_url: "https://github.com/openai/codex/commit/x",
    commit: { message: `Commit ${13 - i}` },
  }));
  const source = "github:openai/codex:commits";
  saveCollection(
    db,
    {
      source,
      stream: "github",
      url: "https://github.com",
      raw: [],
      appendOnly: true,
      records: [{ id: commits[12]?.sha ?? "", name: "old" }],
    },
    [],
  );
  const request = async (url: string) =>
    Response.json(
      url.includes("/commits/")
        ? {
            ...commits[0],
            files: [{ filename: "docs/feature.md", status: "modified", additions: 1, deletions: 0, patch: "+feature" }],
          }
        : commits,
    );
  const first = await collectGithubCommits(db, config, watch, request);
  expect(first.records).toHaveLength(10);
  expect(first.records[0]?.id).toBe(commits[11]?.sha);
  saveCollection(db, first, []);
  const second = await collectGithubCommits(db, config, watch, request);
  expect(second.records).toHaveLength(2);
  expect(second.records[1]?.id).toBe(commits[0]?.sha);
  db.close();
});
test("source redirects retain credentials only on the same origin", async () => {
  let n = 0;
  expect(
    await fetchText("https://example.com", {}, async () =>
      ++n === 1 ? new Response(null, { status: 302, headers: { location: "/login" } }) : new Response("ok"),
    ),
  ).toBe("ok");
  await expect(
    fetchText(
      "https://example.com",
      { Authorization: "secret" },
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
    ),
  ).rejects.toThrow("changed origin");
});

test("Codex documentation uses official Markdown and ignores index boilerplate", async () => {
  const { codexPages, markdownParagraphs } = await import("../src/sources/codex.js");
  expect(
    codexPages(
      "[CLI](https://learn.chatgpt.com/docs/codex/cli.md)\n[Bad](https://example.com/docs/bad.md)\n[Copy](https://learn.chatgpt.com/docs/codex-manual.md)",
    ),
  ).toEqual([{ name: "CLI", url: "https://learn.chatgpt.com/docs/codex/cli.md" }]);
  expect(markdownParagraphs("# CLI\n\n> For the complete documentation index, see index.\n\nNew   feature")).toEqual([
    "# CLI",
    "New feature",
  ]);
  expect(() => markdownParagraphs("<!doctype html>error")).toThrow("Markdown");
});

test("Codex PR monitor suppresses outsiders and distinguishes merges from releases", async () => {
  const { collectGithubPulls } = await import("../src/sources/github.js");
  const db = openDatabase(":memory:");
  const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
  const watch = config.github[0];
  if (!watch) throw new Error("Missing fixture watch");
  const pr = {
    number: 9,
    title: "New tool",
    html_url: "https://github.com/openai/codex/pull/9",
    body: "proposal",
    state: "open",
    draft: false,
    merged_at: null as string | null,
    updated_at: "2026-09-08T01:00:00Z",
    author_association: "MEMBER",
    user: { login: "maintainer" },
    head: { sha: "a".repeat(40) },
  };
  const request = async (url: string) =>
    Response.json(
      url.includes("/files")
        ? [{ filename: "docs/new.md", status: "added", additions: 1, deletions: 0, patch: "+new feature" }]
        : [pr],
    );
  saveCollection(db, await collectGithubPulls(db, config, watch, request), []);
  pr.updated_at = "2026-09-08T02:00:00Z";
  pr.state = "closed";
  pr.merged_at = pr.updated_at;
  const merged = await collectGithubPulls(db, config, watch, request);
  expect(merged.records[0]?.stage).toContain("not a release yet");
  expect(merged.silentIds).toEqual([]);
  saveCollection(db, merged, []);
  pr.number = 10;
  pr.author_association = "NONE";
  pr.updated_at = "2026-09-08T03:00:00Z";
  expect((await collectGithubPulls(db, config, watch, request)).silentIds).toContain("10");
  db.close();
});

test("Hugging Face listing is append-only and keeps access and origin", async () => {
  const { parseHuggingFace } = await import("../src/sources/registries.js");
  const c = parseHuggingFace(
    JSON.stringify([
      {
        id: "openai/whisper-4",
        author: "openai",
        createdAt: "2026-09-01T00:00:00.000Z",
        pipeline_tag: "asr",
        gated: false,
      },
      { id: "openai/secret", author: "openai", createdAt: "2026-09-02T00:00:00.000Z", gated: "auto" },
    ]),
    "openai",
  );
  // A listing that omits a repository is paging, not a deletion.
  expect(c.appendOnly).toBe(true);
  expect(c.records[0]).toMatchObject({ id: "openai/whisper-4", access: "public", category: "asr" });
  expect(c.records[1]).toMatchObject({ access: "gated" });
  expect(() => parseHuggingFace("{}", "openai")).toThrow();
});

test("Hugging Face uses its account allowance when a token is configured", async () => {
  const authorizations: (string | null)[] = [];
  const request = async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return Response.json([]);
  };
  await collectHuggingFace("openai", "test-token", request);
  expect(authorizations).toEqual(["Bearer test-token"]);
});

test("npm is tracked per channel, so a nightly does not become an event per version", async () => {
  const { parseNpm } = await import("../src/sources/registries.js");
  const c = parseNpm(
    JSON.stringify({
      name: "@openai/codex",
      "dist-tags": { latest: "1.2.3", alpha: "1.3.0-alpha.1" },
      time: { "1.2.3": "2026-09-01T00:00:00.000Z", "1.3.0-alpha.1": "2026-09-02T00:00:00.000Z" },
    }),
  );
  expect(c.records.map((r) => r.id).sort()).toEqual(["alpha", "latest"]);
  expect(c.records.find((r) => r.id === "latest")).toMatchObject({ version: "1.2.3" });
});

test("Vercel gateway models carry maker, context and pricing", async () => {
  const { parseVercelGateway } = await import("../src/sources/registries.js");
  const c = parseVercelGateway(
    JSON.stringify({ data: [{ id: "alibaba/qwen-3", name: "Qwen3", owned_by: "alibaba", context_window: 128000 }] }),
  );
  expect(c.stream).toBe("api-models");
  expect(c.records[0]).toMatchObject({ id: "alibaba/qwen-3", name: "Qwen3", maker: "alibaba", context: 128000 });
});

test("pypi reports the current version as one record", async () => {
  const { parsePypi } = await import("../src/sources/registries.js");
  const c = parsePypi(
    JSON.stringify({
      info: { name: "anthropic", version: "1.4.0" },
      releases: { "1.4.0": [{ upload_time_iso_8601: "2026-09-05T10:00:00.000Z" }] },
    }),
  );
  expect(c.records).toHaveLength(1);
  expect(c.records[0]).toMatchObject({ id: "latest", version: "1.4.0", published: "2026-09-05T10:00:00.000Z" });
});

test("DesignArena ranks by elo and stores no vote counters", () => {
  const payload = JSON.stringify({
    success: true,
    category: "website",
    data: [
      { modelId: "second", elo: 1200, winRate: 50, battles: 10 },
      { modelId: "first", elo: 1400, winRate: 70, battles: 12 },
    ],
  });
  const parsed = parseDesignArena(payload, "website");
  expect(parsed.appendOnly).toBeUndefined();
  expect(parsed.url).toBe("https://www.designarena.ai/leaderboard/website");
  expect(parsed.records.map((record) => record.id)).toEqual(["first", "second"]);
  expect(parsed.records[0]).toMatchObject({ rank: 1, category: "designarena/website" });
  // Elo and battles move on every vote; keeping them would make each poll an event.
  expect(parsed.records[0]).not.toHaveProperty("elo");
  expect(parsed.records[0]).not.toHaveProperty("battles");
});
test("Cursor changelog takes the slug as identity and refuses a page it cannot read", () => {
  const html =
    `<a href="/changelog/08-19-26"><time dateTime="2026-08-19T00:00:00.000Z">Aug 19, 2026</time></a>` +
    `<h1 id="08-19-26"><a href="/changelog/08-19-26">Cloud Agents Improvements</a></h1>`;
  const parsed = parseCursorChangelog(html);
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]).toMatchObject({
    id: "08-19-26",
    name: "Cloud Agents Improvements",
    published: "2026-08-19T00:00:00.000Z",
    url: "https://cursor.com/changelog/08-19-26",
  });
  expect(() => parseCursorChangelog("<html>Nothing here</html>")).toThrow("no longer exposes");
  // The page ships the same heading twice for its responsive layout; that is one entry, not two.
  expect(parseCursorChangelog(html + html).records).toHaveLength(1);
});

test("an unchanged page is revalidated, and an immutable asset is not requested at all", async () => {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const seen: { url: string; headers: Headers }[] = [];
  const page = "https://example.test/docs.md";
  const asset = "https://example.test/app-AbCdEf12.js";
  const request = async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url === asset)
      return new Response("asset body", {
        status: 200,
        headers: { "cache-control": "public,max-age=31536000,immutable", etag: '"a1"' },
      });
    const conditional = new Headers(init?.headers).get("if-none-match");
    if (conditional === '"p1"') return new Response(null, { status: 304 });
    return new Response("page body", { status: 200, headers: { etag: '"p1"', "cache-control": "public, max-age=0" } });
  };

  expect(await fetchText(page, {}, request, undefined, cache)).toBe("page body");
  // Second observation: the request still happens, but the answer carries no body.
  expect(await fetchText(page, {}, request, undefined, cache)).toBe("page body");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.headers.get("if-none-match")).toBe('"p1"');

  expect(await fetchText(asset, {}, request, undefined, cache)).toBe("asset body");
  expect(await fetchText(asset, {}, request, undefined, cache)).toBe("asset body");
  // The URL of an immutable asset carries a content hash, so the same URL cannot hold new bytes.
  expect(seen.filter((call) => call.url === asset)).toHaveLength(1);
});
test("only immutable responses are reused without asking", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  expect(freshUntil("public, max-age=3600", now)).toBe(0);
  expect(freshUntil("public,max-age=600,immutable", now)).toBe(now + 600_000);
  // A year of freshness is capped: a cache this project cannot inspect is not a place to lose a page.
  expect(freshUntil("max-age=31536000,immutable", now)).toBe(now + 30 * 24 * 3600 * 1000);
  expect(freshUntil(null, now)).toBe(0);
});

test("a body with no validator is not stored: it cannot save anything later", async () => {
  const db = openDatabase(":memory:");
  const cache = new HttpCache(db);
  const url = "https://example.test/page";
  const request = async () => new Response("body", { status: 200, headers: { "cache-control": "public, max-age=0" } });
  expect(await fetchText(url, {}, request, undefined, cache)).toBe("body");
  expect(cache.get(url)).toBeNull();
});

test("a dropped connection is retried, a refusal is not", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error("TLS connect error");
    return new Response("body", { status: 200 });
  };
  expect(await fetchText("https://example.test/a", {}, flaky)).toBe("body");
  expect(calls).toBe(3);

  calls = 0;
  const refusing = async () => {
    calls += 1;
    return new Response("no", { status: 403 });
  };
  await expect(fetchText("https://example.test/b", {}, refusing)).rejects.toThrow("HTTP 403");
  // Repeating a request the server already refused is how a collector earns a rate limit.
  expect(calls).toBe(1);

  calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("network is unreachable");
  };
  await expect(fetchText("https://example.test/c", {}, failing)).rejects.toThrow("unreachable");
  expect(calls).toBe(3);
}, 30_000);

test("npm keeps the channels people install and drops the per-platform copies", () => {
  const payload = JSON.stringify({
    name: "@openai/codex",
    "dist-tags": {
      latest: "0.153.4",
      alpha: "0.154.0-alpha.7",
      "alpha-win32-x64": "0.154.0-alpha.7-win32-x64",
      "darwin-arm64": "0.153.4-darwin-arm64",
      "linux-x64": "0.153.4-linux-x64",
    },
    time: { "0.153.4": "2026-09-08T00:00:00.000Z" },
  });
  const ids = parseNpm(payload).records.map((record) => record.id);
  // One alpha bump used to arrive as seven identical messages, one per architecture.
  expect(ids.sort()).toEqual(["alpha", "latest"]);
});

test("a deprecation announcement keeps its date and its prose, not its tables", () => {
  const markdown = [
    "## Upcoming deprecations",
    "",
    "### 2026-08-26: Transcription models",
    "",
    "On August 26, 2026, we notified developers using `whisper-1` of their removal on February 26, 2027.",
    "",
    "| Shutdown date | Model |",
    "| --- | --- |",
    "",
    "### 2026-05-01: Older embeddings",
    "",
    "Embedding models retire in November.",
  ].join("\n");
  const parsed = parseOpenAIDeprecations(markdown);
  expect(parsed.stream).toBe("deprecations");
  expect(parsed.records).toHaveLength(2);
  expect(parsed.records[0]).toMatchObject({
    id: "2026-08-26-transcription-models",
    name: "Transcription models (announced 2026-08-26)",
  });
  expect(String(parsed.records[0]?.summary)).toContain("whisper-1");
  // The table under the heading is data for the page, not a sentence for a reader.
  expect(String(parsed.records[0]?.summary)).not.toContain("|");
  expect(() => parseOpenAIDeprecations("# Deprecations\n\nNothing here.")).toThrow("no longer exposes");
});
test("Anthropic model status is tracked per model, so a state change is the event", () => {
  const markdown = [
    "| API model name | Current state | Deprecated | Tentative retirement date |",
    "| --- | --- | --- | --- |",
    "| claude-opus-5 | Active | N/A | Not sooner than July 24, 2027 |",
    "| claude-opus-4-1-20250805 | Retired | June 5, 2026 | August 5, 2026 |",
    "| gpt-4 | Active | N/A | never |",
  ].join("\n");
  const parsed = parseAnthropicDeprecations(markdown);
  // Only Claude rows: the page also links to tables belonging to other platforms.
  expect(parsed.records.map((record) => record.id)).toEqual(["claude-opus-5", "claude-opus-4-1-20250805"]);
  expect(parsed.records[0]).toMatchObject({ stage: "Active", deprecated: null });
  expect(parsed.records[1]).toMatchObject({ stage: "Retired", deprecated: "June 5, 2026" });
});

test("a bot-protection challenge is named as one, not as a broken endpoint", async () => {
  const challenged = async () =>
    new Response("<html>Human Verification</html>", { status: 405, headers: { "x-amzn-waf-action": "captcha" } });
  await expect(fetchText("https://example.test/a", {}, challenged)).rejects.toThrow("challenged by bot protection");
  // A plain refusal still reads as a refusal.
  const refused = async () => new Response("no", { status: 405 });
  await expect(fetchText("https://example.test/b", {}, refused)).rejects.toThrow("HTTP 405");
});

test("a rate limit is obeyed rather than retried", async () => {
  let calls = 0;
  const limited = async () => {
    calls += 1;
    return new Response("slow down", { status: 429 });
  };
  await expect(fetchText("https://example.test/a", {}, limited)).rejects.toThrow("HTTP 429");
  // Answering "too many requests" with another request is the opposite of what was asked.
  expect(calls).toBe(1);
});

test("a rate limit carries the server's reset time to the scheduler", async () => {
  const before = Date.now();
  const limited = async () =>
    new Response("slow down", { status: 429, headers: { ratelimit: '"api|pages|resolvers";r=0;t=120' } });
  try {
    await fetchText("https://example.test/a", {}, limited);
    throw new Error("Expected a rate limit");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceHttpError);
    const retryAt = Date.parse((error as SourceHttpError).retryAt ?? "");
    expect(retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 122_000);
  }
});
