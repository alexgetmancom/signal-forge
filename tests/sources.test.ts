import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events.js";
import { parseArena, parseLeaderboards } from "../src/sources/arena.js";
import { collectAnthropic, collectOpenRouter } from "../src/sources/catalogs.js";
import { claudeAssetImports, extractStrings } from "../src/sources/claude.js";
import { parseCursorChangelog, parseDesignArena, parseModelScope } from "../src/sources/community.js";
import { collectGithubCommits, summarizeDiff } from "../src/sources/github.js";
import { fetchText } from "../src/sources/http.js";
import { parseAnthropicNews, parseOpenAINews } from "../src/sources/news.js";
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
      { modelKey: "a", modelDisplayName: "A", modelOrganization: "Maker", rank: 1 },
      { modelKey: "z", modelDisplayName: "Z", modelOrganization: "Maker", rank: 44 },
    ],
  };
  const parsed = parseLeaderboards(nextPage({ leaderboards: [board] }));
  expect(parsed.records[0]).toMatchObject({ id: "text:overall:a", rank: 1 });
  // Deep in a board the order churns daily; storing it would buy events and no news.
  expect(parsed.records[1]).not.toHaveProperty("rank");
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
test("Claude extraction decodes strings without executing source", () => {
  expect(
    extractStrings(
      'throw Error("never run");const a={defaultMessage:"Hello\\nworld"};x({defaultMessage:"Hello\\nworld"})',
    ),
  ).toEqual(["Hello\nworld"]);
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

test("ModelScope keeps organisation repositories and treats the page as append-only", () => {
  const payload = JSON.stringify({
    Data: {
      Models: [
        { Path: "Qwen", Name: "Qwen4-Next", CreatedTime: 1, Tasks: [{ Name: "text-generation" }] },
        { Path: "Qwen", Name: "Qwen4-Next-FP8", CreatedTime: 2, Tasks: null },
      ],
    },
  });
  const parsed = parseModelScope(payload, "Qwen");
  expect(parsed.source).toBe("modelscope:Qwen");
  expect(parsed.appendOnly).toBe(true);
  expect(parsed.records[0]).toMatchObject({ id: "Qwen/Qwen4-Next", category: "text-generation" });
  // An organisation with nothing published yet is empty, not broken.
  expect(parseModelScope(JSON.stringify({ Data: { Models: null } }), "Qwen").records).toHaveLength(0);
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
