import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events.js";
import { parseArena, parseLeaderboards } from "../src/sources/arena.js";
import { collectAnthropic, collectOpenRouter } from "../src/sources/catalogs.js";
import { extractStrings } from "../src/sources/claude.js";
import { collectGithubCommits, summarizeDiff } from "../src/sources/github.js";
import { fetchText } from "../src/sources/http.js";
import { parseOpenAINews } from "../src/sources/news.js";
import { openDatabase } from "../src/storage/database.js";

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
test("leaderboard identity includes category and ignores score movement", () => {
  const board = {
    arenaSlug: "text",
    leaderboardSlug: "overall",
    entries: [{ modelKey: "a", modelDisplayName: "A", modelOrganization: "Maker", rank: 1 }],
  };
  const first = parseLeaderboards(nextPage({ leaderboards: [board] }));
  board.entries = board.entries.map((e) => ({ ...e, rank: 2 }));
  expect(parseLeaderboards(nextPage({ leaderboards: [board] })).records).toEqual(first.records);
});
test("RSS parses escaped titles and preserves article dates", () => {
  const c = parseOpenAINews(
    "<rss><channel><item><title>Codex &amp; tools</title><link>https://openai.com/index/codex</link><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>",
  );
  expect(c.records[0]?.name).toBe("Codex & tools");
  expect(c.records[0]?.published).toBe("2026-09-07T10:00:00.000Z");
  expect(() => parseOpenAINews("<html>unavailable</html>")).toThrow();
});
test("Claude extraction decodes strings without executing source", () => {
  expect(
    extractStrings(
      'throw Error("never run");const a={defaultMessage:"Hello\\nworld"};x({defaultMessage:"Hello\\nworld"})',
    ),
  ).toEqual(["Hello\nworld"]);
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
  expect(merged.records[0]?.stage).toContain("ещё не релиз");
  expect(merged.silentIds).toEqual([]);
  saveCollection(db, merged, []);
  pr.number = 10;
  pr.author_association = "NONE";
  pr.updated_at = "2026-09-08T03:00:00Z";
  expect((await collectGithubPulls(db, config, watch, request)).silentIds).toContain("10");
  db.close();
});
