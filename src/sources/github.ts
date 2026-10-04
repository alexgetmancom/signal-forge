import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { log } from "../logger.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

const commitSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    html_url: z.url(),
    commit: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough();
const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});
const detailSchema = commitSchema.extend({ files: z.array(fileSchema) });
const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable(),
  html_url: z.url(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
});

/** A known branch head means the append-only commit collector has already caught up. */
export async function githubCommitsUnchanged(
  db: Database,
  config: AppConfig,
  repo: string,
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<boolean> {
  const source = `github:${repo}:commits`;
  if (!db.query("SELECT 1 FROM live_sources WHERE id=? AND last_success IS NOT NULL").get(source)) return false;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.sha",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const sha = (
    await fetchText(`https://api.github.com/repos/${repo}/commits/HEAD`, headers, request, undefined, cache)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new SourceError("schema", "GitHub branch head did not return a commit SHA");
  return Boolean(db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(source, sha));
}

export function summarizeDiff(files: z.infer<typeof fileSchema>[], paths: string[]): string {
  const selected = files.filter(
    (f) =>
      paths.some((p) => f.filename.startsWith(p)) &&
      !/(^|\/)(package-lock\.json|bun\.lock|pnpm-lock\.yaml|Cargo\.lock)$|(^|\/)(generated|vendor|fixtures|snapshots)\/|\.snap$/.test(
        f.filename,
      ),
  );
  return (
    selected
      .slice(0, 5)
      .map((f) => {
        const lines = (f.patch ?? "")
          .split("\n")
          .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
        const excerpt = lines
          .slice(0, 8)
          .map((l) => l.slice(0, 180))
          .join("\n");
        return `${f.filename} (+${f.additions}/−${f.deletions})\n${excerpt || "Binary or unavailable patch; see full diff"}${lines.length > 8 ? "\n… excerpt truncated" : ""}`;
      })
      .join("\n\n")
      .slice(0, 2500) + (selected.length > 5 ? `\n… ${selected.length - 5} more files` : "")
  );
}
export async function collectGithubCommits(
  db: Database,
  config: AppConfig,
  watch: AppConfig["github"][number],
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  const source = `github:${watch.repo}:commits`,
    url = `https://api.github.com/repos/${watch.repo}/commits`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const initialized = Boolean(db.query("SELECT 1 FROM sources WHERE id=? AND last_success IS NOT NULL").get(source));
  const records: RecordData[] = [],
    raw: unknown[] = [],
    silentIds: string[] = [];
  let reachedKnown = false;
  const pending: z.infer<typeof commitSchema>[] = [];
  // A commit that lands between two requests moves everything down, so the last of one page is the
  // first of the next. It is one commit.
  const met = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const body: unknown = JSON.parse(
      await fetchText(`${url}?per_page=100&page=${page}`, headers, request, undefined, cache),
    );
    const commits = z.array(commitSchema).parse(body);
    for (const commit of commits) {
      if (db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(source, commit.sha)) {
        reachedKnown = true;
        break;
      }
      if (!met.has(commit.sha)) pending.push(commit);
      met.add(commit.sha);
    }
    if (reachedKnown || !initialized || commits.length < 100) break;
  }
  // Catch up oldest-first in bounded batches, so a busy repository cannot exhaust the public API limit.
  //
  // A backlog the batches cannot drain -- a repository busier than ten commits a poll, a long
  // outage, or a force-push that left no known commit to stop at -- used to end in a throw that
  // recurred on every poll, because nothing moved the cursor. Past five batches the older commits
  // are recorded silently, without a detail request, and only the newest batch is read and told.
  const BATCH = 10;
  const oldestFirst = pending.reverse();
  const skipped =
    initialized && (!reachedKnown || oldestFirst.length > BATCH * 5) ? Math.max(0, oldestFirst.length - BATCH) : 0;
  if (skipped > 0) log("warn", "GitHub backlog recorded without details", { source, skipped });
  for (const [index, commit] of oldestFirst.slice(0, initialized ? skipped + BATCH : oldestFirst.length).entries()) {
    // Older and not-yet-processed list entries are not evidence for any record in this collection.
    raw.push(commit);
    let summary = "";
    if (initialized && index >= skipped) {
      const detail: unknown = JSON.parse(await fetchText(`${url}/${commit.sha}?per_page=100`, headers, request));
      const parsed = detailSchema.parse(detail);
      raw.push(detail);
      const files = [...parsed.files];
      if (files.length === 100)
        for (let p = 2; p <= 30; p++) {
          const more: unknown = JSON.parse(
            await fetchText(`${url}/${commit.sha}?per_page=100&page=${p}`, headers, request),
          );
          raw.push(more);
          const next = detailSchema.parse(more).files;
          files.push(...next);
          if (next.length < 100) break;
          if (p === 30) throw new SourceError("protocol", "GitHub commit file list exceeds pagination limit");
        }
      summary = summarizeDiff(files, watch.paths);
    }
    if (!summary) silentIds.push(commit.sha);
    records.push({
      id: commit.sha,
      // An empty subject is a real commit; an empty name would fail the whole collection on every poll.
      name: commit.commit.message.split("\n")[0]?.trim() || commit.sha,
      url: commit.html_url,
      summary,
    });
  }
  return {
    source,
    stream: "github",
    url: `https://github.com/${watch.repo}`,
    records,
    raw,
    silentIds,
  };
}
export async function collectGithubReleases(
  db: Database,
  config: AppConfig,
  watch: AppConfig["github"][number],
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  const url = `https://api.github.com/repos/${watch.repo}/releases`,
    headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const source = `github:${watch.repo}:releases`;
  const initialized = Boolean(db.query("SELECT 1 FROM sources WHERE id=? AND last_success IS NOT NULL").get(source));
  const raw: unknown[] = [],
    records: RecordData[] = [],
    silentIds: string[] = [];
  let reachedKnown = false;
  const met = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const body: unknown = JSON.parse(
      await fetchText(`${url}?per_page=5&page=${page}`, headers, request, undefined, cache),
    );
    const releases = z.array(releaseSchema).parse(body);
    // Assets can be huge; retain release metadata and notes rather than irrelevant download inventories.
    raw.push(releases);
    for (const r of releases) {
      // The last of one page can be the first of the next when a release lands between the requests.
      if (met.has(String(r.id))) continue;
      met.add(String(r.id));
      if (db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(source, String(r.id))) reachedKnown = true;
      if (r.draft || r.prerelease) silentIds.push(String(r.id));
      records.push({
        id: String(r.id),
        name: r.name || r.tag_name,
        tag: r.tag_name,
        prerelease: r.prerelease,
        url: r.html_url,
        published: r.published_at,
        summary: (r.body ?? "").slice(0, 3000),
      });
    }
    if (reachedKnown || !initialized || releases.length < 5) break;
    if (page === 20) throw new SourceError("protocol", "GitHub release catch-up exceeds 100 entries; cursor preserved");
  }
  return {
    source,
    stream: "github",
    url: `https://github.com/${watch.repo}/releases`,
    raw,
    silentIds,
    trackChanges: true,
    records: records.reverse(),
  };
}

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.url(),
  body: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  mergedAt: z.string().nullable(),
  updatedAt: z.string(),
  authorAssociation: z.string(),
  author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
  headRefOid: z.string(),
});

const pullResponse = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z
    .object({
      repository: z
        .object({
          pullRequests: z.object({
            nodes: z.array(pullSchema).max(100),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        })
        .nullable(),
    })
    .nullish(),
});

const PULL_QUERY = `query($owner:String!,$name:String!,$after:String) {
  repository(owner:$owner,name:$name) {
    pullRequests(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}) {
      nodes { number title url body state isDraft mergedAt updatedAt authorAssociation
        author { __typename login } headRefOid }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Native metadata only; file patches are still read from REST for the few changed, trusted PRs. */
async function readUpdatedPulls(
  db: Database,
  config: AppConfig,
  repo: string,
  initialized: boolean,
  request: Fetch,
): Promise<{ pulls: z.infer<typeof pullSchema>[]; raw: unknown[] }> {
  if (!config.GITHUB_TOKEN) throw new SourceError("credential", "GITHUB_TOKEN is required for GitHub pull requests");
  const [owner, name] = repo.split("/");
  const source = `github:${repo}:pulls`;
  const pulls: z.infer<typeof pullSchema>[] = [];
  const raw: unknown[] = [];
  const met = new Set<number>();
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const body: unknown = JSON.parse(
      await fetchText(
        "https://api.github.com/graphql",
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        },
        request,
        { method: "POST", body: JSON.stringify({ query: PULL_QUERY, variables: { owner, name, after } }) },
      ),
    );
    const response = pullResponse.parse(body);
    if (response.errors?.length || !response.data?.repository)
      throw new SourceError("protocol", "GitHub pull query returned incomplete results");
    raw.push(body);
    const data = response.data.repository.pullRequests;
    let reachedKnown = false;
    for (const pr of data.nodes) {
      const old = db
        .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
        .get(source, String(pr.number));
      if (old && JSON.parse(old.body).updated === pr.updatedAt) {
        reachedKnown = true;
        break;
      }
      if (!met.has(pr.number)) pulls.push(pr);
      met.add(pr.number);
    }
    if (reachedKnown || !initialized || !data.pageInfo.hasNextPage) return { pulls, raw };
    if (!data.nodes.length || !data.pageInfo.endCursor || data.pageInfo.endCursor === after)
      throw new SourceError("protocol", "GitHub pull pagination did not advance");
    after = data.pageInfo.endCursor;
  }
  throw new SourceError("protocol", "GitHub PR catch-up exceeds 500 entries; cursor preserved");
}

export async function collectGithubPulls(
  db: Database,
  config: AppConfig,
  watch: AppConfig["github"][number],
  request: Fetch = fetch,
): Promise<Collection> {
  const source = `github:${watch.repo}:pulls`;
  const base = `https://api.github.com/repos/${watch.repo}/pulls`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const initialized = Boolean(db.query("SELECT 1 FROM sources WHERE id=? AND last_success IS NOT NULL").get(source));
  const { pulls: pending, raw } = await readUpdatedPulls(db, config, watch.repo, initialized, request);
  const records: RecordData[] = [],
    silentIds: string[] = [];
  for (const pr of pending.reverse().slice(0, initialized ? 5 : pending.length)) {
    const id = String(pr.number);
    const old = db
      .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
      .get(source, id);
    const before = old ? (JSON.parse(old.body) as RecordData) : null;
    const stage =
      pr.mergedAt || pr.state === "MERGED"
        ? "Merged; not a release yet"
        : pr.state === "CLOSED"
          ? "Closed without merging"
          : pr.isDraft
            ? "Draft; not shipped"
            : "Open PR; a proposal, not shipped";
    const trusted = ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.authorAssociation);
    const changed =
      !before || before.head !== pr.headRefOid || before.stage !== stage || before.name !== `#${pr.number} ${pr.title}`;
    let summary = typeof before?.summary === "string" ? before.summary : "";
    if (initialized && trusted && changed) {
      const files: z.infer<typeof fileSchema>[] = [];
      for (let page = 1; page <= 30; page++) {
        const list = z
          .array(fileSchema)
          .parse(JSON.parse(await fetchText(`${base}/${pr.number}/files?per_page=100&page=${page}`, headers, request)));
        files.push(...list);
        if (list.length < 100) break;
        if (page === 30) throw new SourceError("protocol", "GitHub PR file list exceeds pagination limit");
      }
      summary = summarizeDiff(files, watch.paths);
    }
    if (!initialized || !trusted || !changed || !summary) silentIds.push(id);
    records.push({
      id,
      name: `#${pr.number} ${pr.title}`,
      url: pr.url,
      stage,
      author: pr.author?.__typename === "Bot" ? `${pr.author.login}[bot]` : (pr.author?.login ?? "ghost"),
      association: pr.authorAssociation,
      head: pr.headRefOid,
      updated: pr.updatedAt,
      summary,
    });
  }
  return {
    source,
    stream: "github",
    url: `https://github.com/${watch.repo}/pulls`,
    records,
    raw,
    trackChanges: true,
    silentIds,
  };
}
