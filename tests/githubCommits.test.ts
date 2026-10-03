import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { saveCollection } from "../src/events/pipeline.js";
import { collectGithubCommits, githubCommitsUnchanged } from "../src/sources/github.js";
import { openDatabase } from "../src/storage/database.js";
import { HttpCache } from "../src/storage/httpCache.js";

const config = loadConfig({ CONFIG_PATH: new URL("./fixtures/config.json", import.meta.url).pathname });
const watch = config.github[0];
if (!watch) throw new Error("Fixture has no GitHub watch");
const source = `github:${watch.repo}:commits`;
const commit = (n: number) => ({
  sha: String(n).padStart(40, "0"),
  html_url: `https://github.com/${watch.repo}/commit/${n}`,
  author: { login: "maker" },
  commit: { message: `Commit ${n}`, author: { date: "2026-10-03T18:00:00Z" } },
});

function caughtUp() {
  const db = openDatabase(":memory:");
  saveCollection(
    db,
    {
      source,
      stream: "github",
      url: "https://github.com",
      raw: [],
      appendOnly: true,
      records: [{ id: commit(0).sha, name: "known" }],
    },
    [],
  );
  return db;
}

test("a known SHA is enough to skip the commit list, while an unseen head still collects", async () => {
  const db = caughtUp();
  const headers: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    expect(url).toBe(`https://api.github.com/repos/${watch.repo}/commits/HEAD`);
    headers.push(new Headers(init?.headers).get("accept") ?? "");
    return new Response(headers.length === 1 ? commit(0).sha : commit(1).sha);
  };
  expect(await githubCommitsUnchanged(db, config, watch.repo, request)).toBe(true);
  expect(await githubCommitsUnchanged(db, config, watch.repo, request)).toBe(false);
  expect(headers).toEqual(["application/vnd.github.sha", "application/vnd.github.sha"]);
  db.close();
});

test("an uninitialized source needs its first collection, and a malformed head cannot mark success", async () => {
  const db = openDatabase(":memory:");
  let requests = 0;
  const request = async () => {
    requests++;
    return new Response("not a SHA");
  };
  expect(await githubCommitsUnchanged(db, config, watch.repo, request)).toBe(false);
  expect(requests).toBe(0);
  db.close();
  const initialized = caughtUp();
  await expect(githubCommitsUnchanged(initialized, config, watch.repo, request)).rejects.toThrow("commit SHA");
  initialized.close();
});

test("the SHA probe reuses a conditional 304 without decoding a commit list", async () => {
  const db = caughtUp();
  const cache = new HttpCache(db);
  const etag = `"${commit(0).sha}"`;
  let requests = 0;
  const request = async (_url: string, init?: RequestInit) => {
    requests++;
    if (requests === 1) return new Response(commit(0).sha, { headers: { etag } });
    expect(new Headers(init?.headers).get("if-none-match")).toBe(etag);
    return new Response(null, { status: 304 });
  };
  expect(await githubCommitsUnchanged(db, config, watch.repo, request, cache)).toBe(true);
  expect(await githubCommitsUnchanged(db, config, watch.repo, request, cache)).toBe(true);
  db.close();
});

test("commit evidence keeps complete processed list objects and details, without repeating known commits", async () => {
  const db = caughtUp();
  const list = [commit(2), commit(1), commit(0)];
  const detail = (n: number) => ({
    ...commit(n),
    stats: { total: 1 },
    files: [{ filename: "docs/models.md", status: "modified", additions: 1, deletions: 0, patch: "+new model" }],
  });
  const result = await collectGithubCommits(db, config, watch, async (url) => {
    if (!url.includes("/commits/")) return Response.json(list);
    return Response.json(detail(url.includes(commit(1).sha) ? 1 : 2));
  });
  expect(result.records.map((row) => row.id)).toEqual([commit(1).sha, commit(2).sha]);
  expect(result.raw).toEqual([commit(1), detail(1), commit(2), detail(2)]);
  db.close();
});
