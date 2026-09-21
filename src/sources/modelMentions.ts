import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData, SourceAuthority } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";
import { bareModelSlug } from "./mirrors.js";

/**
 * A model is written into code before it is announced. `gpt-6-astra` entered the Codex client's
 * bundled catalogue on 2026-09-03 at 19:47 UTC, a day before any catalogue listed it, and
 * `gpt-5.6-sol` and `-luna` entered its Bedrock catalogue on 2026-06-26, thirteen days before.
 * `gpt-6-luna` reached no vendor repository at all: on 2026-09-21 a proxy that relays Codex traffic
 * had to price it, because the Codex backend was answering some `gpt-5.6-luna` requests with it.
 *
 * So every commit of a watched repository is read, and the only thing taken from it is a model ID
 * on an added line. A commit is never the event; an ID nothing here has recorded anywhere is.
 */
export type MentionWatch = { repo: string; vendor?: string; authority: SourceAuthority };

export const MODEL_MENTION_REPOS: readonly MentionWatch[] = [
  // The client ships a model list, a Bedrock catalogue and per-model prompts; every Codex model so
  // far appeared here first.
  { repo: "openai/codex", vendor: "OpenAI", authority: "vendor_owned" },
  { repo: "openai/openai-python", vendor: "OpenAI", authority: "vendor_owned" },
  { repo: "openai/openai-agents-python", vendor: "OpenAI", authority: "vendor_owned" },
  { repo: "openai/openai-agents-js", vendor: "OpenAI", authority: "vendor_owned" },
  { repo: "anthropics/claude-code", vendor: "Anthropic", authority: "vendor_owned" },
  { repo: "anthropics/anthropic-sdk-python", vendor: "Anthropic", authority: "vendor_owned" },
  { repo: "google-gemini/gemini-cli", vendor: "Google", authority: "vendor_owned" },
  { repo: "googleapis/python-genai", vendor: "Google", authority: "vendor_owned" },
  // Proxies that relay real traffic and record the model a response names. They see what a backend
  // actually serves, which no catalogue says.
  { repo: "d4rken/clankermux", authority: "third_party" },
  { repo: "2lab-ai/llmux", authority: "third_party" },
];

/**
 * The families whose IDs are specific enough to find in prose and code without a list of known
 * models: a family word, a version number, then suffixes. `o3`-style IDs and bare family names are
 * left out; they match too much that is not a model.
 */
const MODEL_ID =
  /(?<![a-z0-9.-])(?:gpt-\d+(?:\.\d+)?|claude-(?:opus|sonnet|haiku|fable|[a-z]+)-\d+(?:[.-]\d+)*|gemini-\d+(?:\.\d+)?|grok-\d+(?:\.\d+)?|glm-\d+(?:\.\d+)?)(?:-[a-z0-9]+(?:\.\d+)*)*(?![a-z0-9])/g;

/**
 * "GPT-6-specific defaults" and "Claude-4-based agents" are prose about a family, not a model.
 * Measured on the Codex history from 2026-08-10: `gpt-6-specific` was one of seven sightings.
 */
const PROSE_SUFFIX =
  /-(?:specific|based|like|style|class|level|family|compatible|era|only|powered|series|generation|native|aware|ready|friendly)$/;

/** A file whose contents are recorded output, not anyone writing a model's name. */
const IGNORED_FILE = /(^|\/)(package-lock\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock)$|\.snap$/;

/**
 * A proxy's tests are invented traffic: clankermux's fixtures carry `claude-opus-5-20260101` and
 * `gpt-6-astra-reported`, models nobody serves. A vendor's tests are not skipped -- `gpt-6-astra-wm`
 * first appeared in a Codex test, and it is a real slug.
 */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|fixtures?|__fixtures__|testdata|mocks?)\/|[._-](test|spec|fixture)s?\.[a-z]+$|_tests?\.[a-z]+$/.test(
    path,
  );
}

/** `gpt-5.4-mini-2026-03-17` is a dated snapshot of `gpt-5.4-mini`; knowing one is knowing the other. */
export function undated(id: string): string {
  return id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/** Model IDs on the added lines of one file's patch, each with the first line that carried it. */
export function modelIdsInPatch(patch: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const match of line.toLowerCase().matchAll(MODEL_ID)) {
      // A trailing dot is the end of a sentence, not a version.
      const id = match[0].replace(/[.-]+$/, "");
      if (PROSE_SUFFIX.test(id)) continue;
      if (!found.has(id)) found.set(id, line.slice(1).trim().slice(0, 240));
    }
  }
  return found;
}

const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  html_url: z.url(),
  commit: z.object({ message: z.string(), author: z.object({ date: z.string() }).nullish() }),
});
const detailSchema = commitSchema.extend({
  files: z.array(z.object({ filename: z.string(), patch: z.string().optional() })).default([]),
});
const compareSchema = z.object({ status: z.string(), commits: z.array(commitSchema) });

const CURSOR = "@head";
/** Commits read in one poll. A busier repository catches up over the following polls. */
const BATCH = 30;

/** Whether any source here has recorded this model, under any spelling a platform gives it. */
function alreadyRecorded(db: Database, id: string): boolean {
  const bare = bareModelSlug(id);
  return Boolean(
    db
      .query(
        "SELECT 1 FROM records WHERE source NOT LIKE 'github:%:models' AND (id=?1 OR id LIKE '%/' || ?1 OR id LIKE '%.' || ?1 || '%' OR body LIKE '%\"' || ?1 || '\"%') LIMIT 1",
      )
      .get(bare),
  );
}

export function mentionSource(repo: string): string {
  return `github:${repo}:models`;
}

export async function collectModelMentions(
  db: Database,
  config: AppConfig,
  watch: MentionWatch,
  request: Fetch = fetch,
): Promise<Collection> {
  const source = mentionSource(watch.repo);
  const api = `https://api.github.com/repos/${watch.repo}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const base = { source, stream: "github", url: `https://github.com/${watch.repo}`, appendOnly: true } as const;
  const stored = db
    .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
    .get(source, CURSOR);
  const cursor = stored ? (JSON.parse(stored.body) as { sha?: string }).sha : undefined;
  const head = z
    .array(commitSchema)
    .min(1)
    .parse(JSON.parse(await fetchText(`${api}/commits?per_page=1`, headers, request)))[0];
  if (!head) throw new Error(`${watch.repo}: no commits`);
  const at = (sha: string): RecordData => ({ id: CURSOR, name: "Last commit read", sha });
  // The first read, and a history rewritten under the cursor, start from the head: what the
  // repository already says is its past, not news.
  if (!cursor) return { ...base, raw: head, records: [at(head.sha)], silentIds: [CURSOR] };
  if (cursor === head.sha) return { ...base, raw: head, records: [at(cursor)], silentIds: [CURSOR] };
  let compare: z.infer<typeof compareSchema>;
  try {
    compare = compareSchema.parse(
      JSON.parse(await fetchText(`${api}/compare/${cursor}...${head.sha}`, headers, request)),
    );
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message))
      return { ...base, raw: head, records: [at(head.sha)], silentIds: [CURSOR] };
    throw error;
  }
  if (compare.status !== "ahead") return { ...base, raw: compare, records: [at(head.sha)], silentIds: [CURSOR] };

  const batch = compare.commits.slice(0, BATCH);
  const records: RecordData[] = [];
  const silentIds = [CURSOR];
  const seen = new Set<string>();
  const raw: unknown[] = [];
  for (const commit of batch) {
    const detail = detailSchema.parse(JSON.parse(await fetchText(`${api}/commits/${commit.sha}`, headers, request)));
    raw.push({ sha: detail.sha, files: detail.files.map((file) => file.filename) });
    for (const file of detail.files) {
      if (!file.patch || IGNORED_FILE.test(file.filename)) continue;
      if (watch.authority === "third_party" && isTestFile(file.filename)) continue;
      for (const [id, line] of modelIdsInPatch(file.patch)) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(source, id)) continue;
        records.push({
          id,
          name: id,
          ...(watch.vendor ? { maker: watch.vendor } : {}),
          url: `${detail.html_url}`,
          commit: detail.commit.message.split("\n")[0]?.trim() || detail.sha,
          ...(detail.commit.author?.date ? { committed: detail.commit.author.date } : {}),
          file: file.filename,
          line,
        });
        if (alreadyRecorded(db, id) || (undated(id) !== id && alreadyRecorded(db, undated(id)))) silentIds.push(id);
      }
    }
  }
  const last = batch.at(-1)?.sha ?? head.sha;
  return { ...base, raw, records: [at(last), ...records], silentIds };
}
