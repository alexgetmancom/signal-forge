import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Fetch } from "../delivery.js";
import type { Collection, RecordData } from "../events.js";
import { fetchText } from "./http.js";

const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  html_url: z.url(),
  commit: z.object({ message: z.string() }),
});
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
  for (let page = 1; page <= 10; page++) {
    const body: unknown = JSON.parse(await fetchText(`${url}?per_page=100&page=${page}`, headers, request));
    const commits = z.array(commitSchema).parse(body);
    raw.push(body);
    for (const commit of commits) {
      if (db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(source, commit.sha)) {
        reachedKnown = true;
        break;
      }
      pending.push(commit);
    }
    if (reachedKnown || !initialized || commits.length < 100) break;
    if (page === 10) throw new Error("GitHub catch-up exceeds 1000 commits; cursor preserved");
  }
  // Catch up oldest-first in bounded batches, so a busy repository cannot exhaust the public API limit.
  for (const commit of pending.reverse().slice(0, initialized ? 10 : pending.length)) {
    let summary = "";
    if (initialized) {
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
          if (p === 30) throw new Error("GitHub commit file list exceeds pagination limit");
        }
      summary = summarizeDiff(files, watch.paths);
    }
    if (!summary) silentIds.push(commit.sha);
    records.push({
      id: commit.sha,
      name: commit.commit.message.split("\n")[0] ?? commit.sha,
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
    appendOnly: true,
    silentIds,
  };
}
export async function collectGithubReleases(
  db: Database,
  config: AppConfig,
  watch: AppConfig["github"][number],
  request: Fetch = fetch,
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
  for (let page = 1; page <= 20; page++) {
    const body: unknown = JSON.parse(await fetchText(`${url}?per_page=5&page=${page}`, headers, request));
    const releases = z.array(releaseSchema).parse(body);
    // Assets can be huge; retain release metadata and notes rather than irrelevant download inventories.
    raw.push(releases);
    for (const r of releases) {
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
    if (page === 20) throw new Error("GitHub release catch-up exceeds 100 entries; cursor preserved");
  }
  return {
    source,
    stream: "github",
    url: `https://github.com/${watch.repo}/releases`,
    raw,
    appendOnly: true,
    silentIds,
    trackChanges: true,
    records: records.reverse(),
  };
}

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.url(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  updated_at: z.string(),
  author_association: z.string(),
  user: z.object({ login: z.string() }),
  head: z.object({ sha: z.string() }),
});
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
  const pending: z.infer<typeof pullSchema>[] = [];
  const raw: unknown[] = [],
    records: RecordData[] = [],
    silentIds: string[] = [];
  let reachedKnown = false;
  for (let page = 1; page <= 5; page++) {
    const pulls = z
      .array(pullSchema)
      .parse(
        JSON.parse(
          await fetchText(`${base}?state=all&sort=updated&direction=desc&per_page=100&page=${page}`, headers, request),
        ),
      );
    raw.push(pulls);
    for (const pr of pulls) {
      const old = db
        .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
        .get(source, String(pr.number));
      if (old && JSON.parse(old.body).updated === pr.updated_at) {
        reachedKnown = true;
        break;
      }
      pending.push(pr);
    }
    if (reachedKnown || !initialized || pulls.length < 100) break;
    if (page === 5) throw new Error("GitHub PR catch-up exceeds 500 entries; cursor preserved");
  }
  for (const pr of pending.reverse().slice(0, initialized ? 5 : pending.length)) {
    const id = String(pr.number);
    const old = db
      .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
      .get(source, id);
    const before = old ? (JSON.parse(old.body) as RecordData) : null;
    const stage = pr.merged_at
      ? "Слито в репозиторий; это ещё не релиз"
      : pr.state === "closed"
        ? "Закрыто без слияния"
        : pr.draft
          ? "Черновик; не выпущено"
          : "Открытый PR; предложение, не выпущено";
    const trusted = ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association);
    const changed =
      !before || before.head !== pr.head.sha || before.stage !== stage || before.name !== `#${pr.number} ${pr.title}`;
    let summary = typeof before?.summary === "string" ? before.summary : "";
    if (initialized && trusted && changed) {
      const files: z.infer<typeof fileSchema>[] = [];
      for (let page = 1; page <= 30; page++) {
        const list = z
          .array(fileSchema)
          .parse(JSON.parse(await fetchText(`${base}/${pr.number}/files?per_page=100&page=${page}`, headers, request)));
        files.push(...list);
        if (list.length < 100) break;
        if (page === 30) throw new Error("GitHub PR file list exceeds pagination limit");
      }
      summary = summarizeDiff(files, watch.paths);
    }
    if (!initialized || !trusted || !changed || !summary) silentIds.push(id);
    records.push({
      id,
      name: `#${pr.number} ${pr.title}`,
      url: pr.html_url,
      stage,
      author: pr.user.login,
      association: pr.author_association,
      head: pr.head.sha,
      updated: pr.updated_at,
      summary,
    });
  }
  return {
    source,
    stream: "github",
    url: `https://github.com/${watch.repo}/pulls`,
    records,
    raw,
    appendOnly: true,
    trackChanges: true,
    silentIds,
  };
}
