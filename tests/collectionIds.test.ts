import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import type { Collection } from "../src/events/types.js";
import { SourceError } from "../src/failure.js";
import { parseDeepSeekUpdates } from "../src/sources/deepseek.js";
import { parseOpenAIDeprecations } from "../src/sources/deprecations.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "../src/sources/github.js";
import { distinctIds, firstOfEach } from "../src/sources/ids.js";
import { collectLabPages, minimaxReleases } from "../src/sources/labPages.js";
import { parseCohereChangelog } from "../src/sources/modelDocs.js";
import { parseOpenAINews } from "../src/sources/news.js";
import { collectMimoTraining } from "../src/sources/training.js";
import { openDatabase } from "../src/storage/database.js";

/**
 * `persistCollection` refuses a collection with a repeated id whole, and what it refuses is every
 * record of the source with it: two release-note entries of one day under one title stopped a page
 * for as long as they stood. These are the collectors that build an id from something two entries
 * can share, or that read a list in pages, and each of them has to hand over a collection the store
 * accepts. Every case goes through `saveCollection`, because "no repeated id" is the store's rule.
 */
const accepted = (collection: Collection) => {
  const db = openDatabase(":memory:");
  expect(() => saveCollection(db, collection, [])).not.toThrow();
  db.close();
};

test("a collection that repeats an id is refused as a schema failure that says where the repeat is", () => {
  const db = openDatabase(":memory:");
  const collection: Collection = {
    source: "s",
    stream: "news",
    url: "https://example.test",
    raw: [],
    records: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "a", name: "A again" },
    ],
  };
  let refused: unknown;
  try {
    saveCollection(db, collection, []);
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(SourceError);
  expect(refused).toMatchObject({ kind: "schema", message: "s: duplicate record IDs", evidence: { index: 2 } });
  db.close();
});

test("distinct ids leave unique ids alone, give a repeat to the later arrival, and never take an id that exists", () => {
  const ids = (records: { id: string }[]) => records.map((record) => record.id);
  expect(ids(distinctIds([{ id: "a" }, { id: "b" }]))).toEqual(["a", "b"]);
  // Newest first: the entry that has been there longest keeps its id.
  expect(ids(distinctIds([{ id: "a" }, { id: "a" }, { id: "a" }]))).toEqual(["a-3", "a-2", "a"]);
  // A suffix that is itself an id on the page is skipped.
  expect(ids(distinctIds([{ id: "a" }, { id: "a-2" }, { id: "a" }]))).toEqual(["a-3", "a-2", "a"]);
  // One thing listed twice is one record, wherever the repeat sits.
  expect(ids(firstOfEach([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }, { id: "b" }]))).toEqual(["a", "b", "c"]);
});

test("two MiniMax cards with one title are two entries, and the one that was there first keeps its id", async () => {
  const card = (title: string, href: string) => `<Card title="${title}" icon="video" href="${href}" cta="Learn More">`;
  const page = [
    "#### Jul. 31, 2026",
    card("MiniMax H3", "https://www.minimax.io/blog/minimax-h3"),
    "#### Jun. 1, 2026",
    card("MiniMax H3", "https://platform.minimax.io/docs/guides/h3"),
  ].join("\n");
  expect(minimaxReleases(page).map((entry) => entry.id)).toEqual(["MiniMax H3-2", "MiniMax H3"]);
  // A card added above moves nobody else's id.
  expect(
    minimaxReleases(`#### Aug. 5, 2026\n${card("MiniMax H3", "https://x.test/new")}\n${page}`).map((entry) => entry.id),
  ).toEqual(["MiniMax H3-3", "MiniMax H3-2", "MiniMax H3"]);
  accepted(await collectLabPages("minimax-release-notes", async () => new Response(page)));
});

test("two OpenAI deprecation notices of one day under one title are two notices", () => {
  const notice = (title: string, body: string) => `### 2026-08-26: ${title}\n\n${body}\n`;
  const parsed = parseOpenAIDeprecations(
    `## Upcoming deprecations\n\n${notice("Transcription models", "Whisper retires.")}\n${notice("Transcription Models", "TTS retires.")}`,
  );
  expect(parsed.records.map((record) => record.id)).toEqual([
    "2026-08-26-transcription-models-2",
    "2026-08-26-transcription-models",
  ]);
  accepted(parsed);
});

test("two DeepSeek updates that carry no anchor of their own are two updates", () => {
  const parsed = parseDeepSeekUpdates(
    "<article><h2>Date: 2026-08-21</h2><h3>Improvements</h3><p>a</p><h3>Improvements</h3><p>b</p></article>",
  );
  expect(new Set(parsed.records.map((record) => record.id)).size).toBe(2);
  accepted(parsed);
  // Anchors the page does give are the ids, as before.
  expect(
    parseDeepSeekUpdates(
      '<article><h2>Date: 2026-08-21</h2><h3 id="one">A</h3><p>a</p><h3 id="two">B</h3><p>b</p></article>',
    ).records.map((record) => record.id),
  ).toEqual(["2026-08-21:one", "2026-08-21:two"]);
});

test("a link the news feed lists twice is one article", () => {
  const item = (title: string) =>
    `<item><title>${title}</title><link>https://openai.com/index/x</link><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate></item>`;
  const parsed = parseOpenAINews(`<rss><channel>${item("First")}${item("Second")}</channel></rss>`);
  expect(parsed.records.map((record) => record.name)).toEqual(["First"]);
  accepted(parsed);
});

test("a Cohere changelog entry listed with and without its .md is one entry", () => {
  const parsed = parseCohereChangelog(
    "- [Parse](https://docs.cohere.com/changelog/parse.md): x\n- [Parse](https://docs.cohere.com/changelog/parse): x\n- [Other](https://docs.cohere.com/changelog/other): y",
  );
  expect(parsed.records.map((record) => record.id)).toEqual(["/changelog/parse", "/changelog/other"]);
  accepted(parsed);
});

test("a training run restarted under the same label is one model, told by its latest run", async () => {
  const runs = [
    { key: "r1", label: "mimo-v2.6-pro", start: 1_700_000_000, end: 1_700_100_000 },
    { key: "r2", label: "mimo-v2.6-pro", start: 1_700_200_000, end: null },
  ];
  const request = (async (url: string) => {
    if (String(url).endsWith("/api/runs"))
      return Response.json({ runs: runs.map(({ key, label }) => ({ key, label })) });
    const run = runs.find((candidate) => String(url).endsWith(`run=${candidate.key}`));
    return Response.json({ run: { ...run, mode: "live" } });
  }) as unknown as typeof fetch;
  const collection = await collectMimoTraining(request);
  expect(collection.records).toHaveLength(1);
  expect(collection.records[0]).toMatchObject({ id: "mimo-v2.6-pro", started: "2023-11-17T05:46:40.000Z" });
  expect(collection.records[0]).not.toHaveProperty("ended");
  accepted(collection);
});

const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
const watch = config.github[0];
if (!watch) throw new Error("Missing fixture watch");

/** A source that has been read before, so the next read is a catch-up that walks pages. */
function readBefore(source: string, id: string) {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    { source, stream: "github", url: "https://github.com", raw: [], appendOnly: true, records: [{ id, name: "old" }] },
    [],
  );
  return db;
}
const pageOf = (url: string) => Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);

test("a commit that moves down a page between two requests is read once", async () => {
  const sha = (n: number) => String(n).padStart(40, "0");
  const commit = (n: number) => ({
    sha: sha(n),
    html_url: `https://github.com/openai/codex/commit/${n}`,
    commit: { message: `Commit ${n}` },
  });
  const db = readBefore("github:openai/codex:commits", sha(1));
  // 150 commits newer than the one stored. A new one lands between the first request and the second,
  // so the last of the first page is also the first of the second.
  const newest = Array.from({ length: 100 }, (_, i) => commit(250 - i));
  const second = [commit(151), ...Array.from({ length: 49 }, (_, i) => commit(150 - i)), commit(1)];
  const request = (async (url: string) => {
    if (url.includes("/commits/")) return Response.json({ ...commit(0), files: [] });
    return Response.json(pageOf(url) === 1 ? newest : second);
  }) as unknown as typeof fetch;
  const collection = await collectGithubCommits(db, config, watch, request);
  const ids = collection.records.map((record) => record.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(149);
  saveCollection(db, collection, []);
  db.close();
});

test("a release that moves down a page between two requests is read once", async () => {
  const release = (id: number) => ({
    id,
    tag_name: `v${id}`,
    name: `Release ${id}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/openai/codex/releases/tag/v${id}`,
    published_at: "2026-09-01T00:00:00Z",
    body: "notes",
  });
  const db = readBefore("github:openai/codex:releases", "1");
  const first = [20, 19, 18, 17, 16].map(release);
  const second = [16, 15, 14, 13, 12].map(release);
  const third = [release(1)];
  const request = (async (url: string) =>
    Response.json([first, second, third][pageOf(url) - 1] ?? [])) as unknown as typeof fetch;
  const collection = await collectGithubReleases(db, config, watch, request);
  const ids = collection.records.map((record) => record.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(10);
  saveCollection(db, collection, []);
  db.close();
});

test("a pull request that moves down a page between two requests is read once", async () => {
  const pull = (number: number) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/openai/codex/pull/${number}`,
    body: null,
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    updatedAt: "2026-09-01T00:00:00Z",
    authorAssociation: "NONE",
    author: { __typename: "User", login: "someone" },
    headRefOid: `${number}`.padStart(40, "0"),
  });
  const db = readBefore("github:openai/codex:pulls", "1");
  // A catch-up that is just over one page keeps the oldest five of what it found, which is where
  // the pull that moved down a page and the one it moved past both are.
  const first = Array.from({ length: 100 }, (_, i) => pull(300 - i));
  const second = [pull(201), pull(200), pull(199)];
  const request = (async (_url: string, init?: RequestInit) => {
    const after = JSON.parse(String(init?.body)).variables.after;
    return Response.json({
      data: {
        repository: {
          pullRequests: {
            nodes: after ? second : first,
            pageInfo: { hasNextPage: !after, endCursor: after ? null : "next" },
          },
        },
      },
    });
  }) as unknown as typeof fetch;
  const collection = await collectGithubPulls(db, { ...config, GITHUB_TOKEN: "test-token" }, watch, request);
  const ids = collection.records.map((record) => record.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(5);
  saveCollection(db, collection, []);
  db.close();
});

test("native PR metadata preserves bot names and handles a deleted author", async () => {
  const db = openDatabase(":memory:");
  const nodes = [
    { number: 10, author: { __typename: "Bot", login: "dependabot" } },
    { number: 9, author: null },
  ].map((pr) => ({
    ...pr,
    title: "Tool",
    url: `https://github.com/openai/codex/pull/${pr.number}`,
    body: "proposal",
    state: "OPEN",
    isDraft: true,
    mergedAt: null,
    updatedAt: "2026-10-04T12:00:00Z",
    authorAssociation: "NONE",
    headRefOid: "a".repeat(40),
  }));
  const request = async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.github.com/graphql");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).query).toContain("UPDATED_AT,direction:DESC");
    return Response.json({
      data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
  };
  try {
    const collection = await collectGithubPulls(db, { ...config, GITHUB_TOKEN: "test-token" }, watch, request);
    expect(collection.records.map((record) => record.author)).toEqual(["ghost", "dependabot[bot]"]);
    expect(collection.silentIds).toEqual(["9", "10"]);
    saveCollection(db, collection, []);
  } finally {
    db.close();
  }
});

test("a partial GraphQL answer fails without publishing upstream error text", async () => {
  const db = openDatabase(":memory:");
  const request = async () => Response.json({ errors: [{ message: "private upstream detail" }], data: null });
  try {
    const error = await collectGithubPulls(db, { ...config, GITHUB_TOKEN: "test-token" }, watch, request).catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(SourceError);
    expect(error.message).toBe("GitHub pull query returned incomplete results");
    expect(error.message).not.toContain("private upstream");
  } finally {
    db.close();
  }
});
