import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";
import { judgeMentions, stageKnown, stageRecordId } from "./mentionStage.js";
import { type MentionWatch, modelIdsInText } from "./modelMentions.js";

/**
 * Users say what they were served before anyone commits a fix for it: "I asked for gpt-5.6-luna and
 * the response says gpt-6-luna". Issues, their comments and discussions of the watched repositories
 * are read for model IDs, and only a user reporting a model answering them is told. That a user
 * names a model -- a wish, a rumour, a comparison -- is kept quietly: anyone can type `gpt-7`.
 */
export function talkSource(repo: string): string {
  return `github:${repo}:talk`;
}

const CURSOR = "@since";
const PAGE = 50;

const userSchema = z.object({ login: z.string() }).nullish();
const issueSchema = z.object({
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullish(),
  updated_at: z.string(),
  user: userSchema,
  pull_request: z.unknown().optional(),
});
const commentSchema = z.object({
  html_url: z.url(),
  body: z.string().nullish(),
  updated_at: z.string(),
  user: userSchema,
});
const discussionsSchema = z.object({
  data: z.object({
    repository: z
      .object({
        discussions: z.object({
          nodes: z.array(
            z.object({
              url: z.url(),
              title: z.string(),
              body: z.string().nullish(),
              updatedAt: z.string(),
              author: userSchema,
              comments: z.object({
                nodes: z.array(
                  z.object({ url: z.url(), body: z.string().nullish(), updatedAt: z.string(), author: userSchema }),
                ),
              }),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

type Post = { url: string; title?: string; body: string; updated: string; author?: string };

const DISCUSSIONS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
  discussions(first:${PAGE},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
    url title body updatedAt author{login}
    comments(last:30){nodes{url body updatedAt author{login}}}}}}}`;

async function posts(
  config: AppConfig,
  repo: string,
  since: string,
  headers: Record<string, string>,
  request: Fetch,
): Promise<Post[]> {
  const api = `https://api.github.com/repos/${repo}`;
  const query = `since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=${PAGE}`;
  const issues = z
    .array(issueSchema)
    .parse(JSON.parse(await fetchText(`${api}/issues?state=all&${query}`, headers, request)));
  const comments = z
    .array(commentSchema)
    .parse(JSON.parse(await fetchText(`${api}/issues/comments?${query}`, headers, request)));
  const found: Post[] = [
    // A pull request is a commit on its way; the commits are read already.
    ...issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        url: issue.html_url,
        title: issue.title,
        body: issue.body ?? "",
        updated: issue.updated_at,
        ...(issue.user ? { author: issue.user.login } : {}),
      })),
    ...comments.map((comment) => ({
      url: comment.html_url,
      body: comment.body ?? "",
      updated: comment.updated_at,
      ...(comment.user ? { author: comment.user.login } : {}),
    })),
  ];
  if (config.GITHUB_TOKEN) {
    const [owner, name] = repo.split("/");
    const response = await request("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query: DISCUSSIONS_QUERY, variables: { owner, name } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${repo} discussions: HTTP ${response.status}`);
    const discussions = discussionsSchema.parse(await response.json()).data.repository?.discussions.nodes ?? [];
    for (const discussion of discussions) {
      if (discussion.updatedAt <= since) continue;
      found.push({
        url: discussion.url,
        title: discussion.title,
        body: discussion.body ?? "",
        updated: discussion.updatedAt,
        ...(discussion.author ? { author: discussion.author.login } : {}),
      });
      for (const comment of discussion.comments.nodes) {
        if (comment.updatedAt <= since) continue;
        found.push({
          url: comment.url,
          body: comment.body ?? "",
          updated: comment.updatedAt,
          ...(comment.author ? { author: comment.author.login } : {}),
        });
      }
    }
  }
  return found.filter((post) => post.updated > since).sort((a, b) => a.updated.localeCompare(b.updated));
}

export async function collectRepoTalk(
  db: Database,
  config: AppConfig,
  watch: MentionWatch,
  request: Fetch = fetch,
  now = new Date(),
): Promise<Collection> {
  const source = talkSource(watch.repo);
  const base = { source, stream: "github", url: `https://github.com/${watch.repo}`, appendOnly: true } as const;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const cursorRow = db
    .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
    .get(source, CURSOR);
  const since = cursorRow ? (JSON.parse(cursorRow.body) as { at?: string }).at : undefined;
  const at = (iso: string): RecordData => ({ id: CURSOR, name: "Read up to", at: iso });
  // What was said before the first read is the repository's past.
  if (!since) return { ...base, raw: [], records: [at(now.toISOString())], silentIds: [CURSOR] };

  const stored = db.query("SELECT 1 FROM records WHERE source=? AND id=?");
  const found = await posts(config, watch.repo, since, headers, request);
  const records: RecordData[] = [];
  const silentIds = [CURSOR];
  const told = new Set<string>();
  for (const post of found) {
    const text = `${post.title ? `${post.title}\n\n` : ""}${post.body}`;
    const ids = [...modelIdsInText(text)].filter(
      ([id]) => !told.has(id) && !stored.get(source, stageRecordId(id, "served")),
    );
    if (ids.length === 0) continue;
    const stages = await judgeMentions(
      config,
      request,
      "issue",
      text,
      ids.map(([id]) => id),
    );
    for (const [id, line] of ids) {
      const stage = stages.get(id) ?? "named";
      const recordId = stageRecordId(id, stage);
      if (stored.get(source, recordId) || records.some((record) => record.id === recordId)) continue;
      if (stage === "served") told.add(id);
      records.push({
        id: recordId,
        name: stage === "served" ? `${id} served` : id,
        model: id,
        stage,
        ...(watch.vendor ? { maker: watch.vendor } : {}),
        url: post.url,
        ...(post.title ? { title: post.title } : {}),
        ...(post.author ? { author: post.author } : {}),
        posted: post.updated,
        line,
      });
      // Only a report of being served is news from users; a name they type is not.
      if (stage !== "served" || stageKnown(db, id, stage)) silentIds.push(recordId);
    }
  }
  // Pages are read oldest first, so a full page moves the cursor to its last post, not past the rest.
  const last = found.at(-1)?.updated;
  const next = found.length >= PAGE && last ? last : last && last > since ? last : since;
  return { ...base, raw: found.map((post) => post.url), records: [at(next), ...records], silentIds };
}
