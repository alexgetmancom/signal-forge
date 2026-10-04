import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collection, RecordData, SourceAuthority } from "../events/types.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { log } from "../logger.js";
import { fetchResponse, fetchText, readResponseStream, SourceHttpError } from "./http.js";
import { judgeMentions, type MentionStage, olderThanKnown, stageKnown, stageRecordId } from "./mentionStage.js";
import type { Vendor } from "./vendors.js";

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
export type MentionWatch = {
  repo: string;
  vendor?: Vendor;
  authority: SourceAuthority;
  /** Only these files are read, where the rest of a repository names models that are not its own. */
  paths?: readonly string[];
  /** A closed product's repository: no code, only its users' issues. */
  talkOnly?: true;
};

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
  /**
   * MiniMax ships its coding client from its own repository, and the client carries the catalogue
   * it will call. `MiniMax-M3.1` sat in five of its test files on 2026-09-24 -- ordered ahead of M3
   * in the catalogue tests -- while nothing else this tracker reads had ever written the name.
   */
  { repo: "MiniMax-AI/minimax-code", vendor: "MiniMax", authority: "vendor_owned" },
  // Proxies that relay real traffic and record the model a response names. They see what a backend
  // actually serves, which no catalogue says.
  { repo: "d4rken/clankermux", authority: "third_party" },
  { repo: "2lab-ai/llmux", authority: "third_party" },
  /**
   * Gateways and coding agents that price or list a model the day it can be called. Replayed from
   * June to 2026-09-21: opencode listed `grok-4.7` seven minutes before xAI's catalogue did, and
   * LiteLLM priced `claude-mythos-5-1` on 2026-09-05. Most of their additions trail the vendors by
   * hours -- they are here for the ones that do not.
   *
   * LiteLLM is read only for its price table: its Hugging Face lists carry a hundred `gpt-2-*`
   * fine-tunes, and its router presets version every model `-v1`. Cline was left out -- it names
   * its own variants, `claude-opus-5-thinking`, `gpt-6-astra-fast`, that no vendor serves -- and so
   * were Aider (untouched since May) and OpenRouter's repositories, whose catalogue is read already.
   */
  {
    repo: "BerriAI/litellm",
    authority: "third_party",
    paths: ["model_prices_and_context_window.json", "litellm/model_prices_and_context_window_backup.json"],
  },
  { repo: "anomalyco/opencode", authority: "third_party" },
  /**
   * Vercel's AI Gateway settings list every model the gateway routes. `deepseek-v4.1-flash-beta`
   * entered it on 2026-09-08; DeepSeek's weights reached Hugging Face on 2026-09-10.
   */
  {
    repo: "vercel/ai",
    authority: "third_party",
    paths: ["packages/gateway/src/gateway-language-model-settings.ts"],
  },
  /**
   * Command Code, a coding agent on open models, keeps its code private; its repository is its
   * issue tracker, where users say which model answered them.
   */
  { repo: "CommandCodeAI/command-code", authority: "third_party", talkOnly: true },
];

/**
 * The makers whose IDs are specific enough to find in prose and code without a list of known
 * models: a family word, a version number, then suffixes. `o3`-style IDs and bare family names are
 * left out; they match too much that is not a model.
 *
 * One entry is a maker. `shape` is a family and a version, and nothing after them; `words` are the
 * names the maker's IDs are written with, which is how an ID that carries two makers' words is
 * told. A maker added here is found in prose, kept by a first read and caught when crossed -- the
 * three used to be three lists, and a name missing from one of them failed without a sound.
 */
const MAKERS: readonly { words: readonly string[]; shape: string }[] = [
  { words: ["gpt"], shape: String.raw`gpt-\d+(?:\.\d+)?` },
  /**
   * A version is the usual way a Claude model is told from its family, and `preview` is the other
   * one: `claude-mythos-preview` is a real ID, published in deprecations and in Azure's lifecycle
   * table, and a shape that demanded a digit could not see it at all. The stages are a closed list
   * written here, not a wildcard, because `claude-<anything>-<anything>` is mostly prose.
   */
  { words: ["claude"], shape: String.raw`claude-[a-z]+-(?:\d+(?:[.-]\d+)*|preview|alpha|beta)` },
  { words: ["gemini"], shape: String.raw`gemini-\d+(?:\.\d+)?` },
  { words: ["grok"], shape: String.raw`grok-\d+(?:\.\d+)?` },
  { words: ["glm"], shape: String.raw`glm-\d+(?:\.\d+)?` },
  { words: ["kimi"], shape: String.raw`kimi-k\d+(?:\.\d+)?` },
  { words: ["deepseek"], shape: String.raw`deepseek-[vr]\d+(?:\.\d+)?` },
  { words: ["qwen"], shape: String.raw`qwen\d+(?:\.\d+)?` },
  { words: ["minimax"], shape: String.raw`minimax-m\d+(?:\.\d+)?` },
  {
    words: ["mistral", "magistral", "devstral", "codestral"],
    shape: String.raw`(?:mistral|magistral|devstral|codestral)-(?:large-|medium-|small-)?\d+(?:\.\d+)?`,
  },
];
const FAMILY_SHAPE = MAKERS.map((maker) => maker.shape).join("|");
const MODEL_ID = new RegExp(String.raw`(?<![a-z0-9.-])(?:${FAMILY_SHAPE})(?:-[a-z0-9]+(?:\.\d+)*)*(?![a-z0-9])`, "g");

/**
 * "GPT-6-specific defaults" and "Claude-4-based agents" are prose about a family, not a model.
 * Measured on the Codex history from 2026-08-10: `gpt-6-specific` was one of seven sightings.
 */
const PROSE_WORDS = [
  "specific",
  "based",
  "like",
  "style",
  "class",
  "level",
  "family",
  "compatible",
  "era",
  "only",
  "powered",
  "series",
  "generation",
  "native",
  "aware",
  "ready",
  "friendly",
] as const;
const PROSE_SUFFIX = new RegExp(`-(?:${PROSE_WORDS.join("|")})$`);

/**
 * `gpt-5.6-and-later`, `gpt-4-turbo-and-gpt-4`: a sentence joined by hyphens, not one model. And a
 * page's path is one too -- LiteLLM's price table carried `kimi-k2-5-now-in-microsoft-foundry` and
 * `kimi-k2-5-quickstart` from the links in its entries.
 */
const JOINED = /-(?:and|or|vs|versus|to|than|through|in|now|with|for|on|quickstart|demo|guide|docs)(?:-|$)/;

/**
 * A size, a quantisation, a host's throughput tier or region: one open-weight model served another
 * way, not another model. Replayed from August, these were most of what gateways and coding agents
 * named in the open families -- `qwen3-1p7b-fp8-draft`, `qwen3-coder-30b-a3b-instruct-gguf`,
 * `deepseek-r1-0528-tput`, `kimi-k3-us`.
 */
const CHECKPOINT =
  /-(?:a?\d+(?:p\d+)?[bm]|fp\d+|nvfp\d+|bf16|int\d+|w\d+a\d+|gguf|awq|gptq|mlx|tput|throughput|draft|maas|us|eu|global)(?:-|$)/;

/**
 * The words that name a maker's line. Two of them in one ID is a proxy's own alias, not a model:
 * on 2026-09-23 clankermux taught itself to prefix a model with the client that asks for it, and
 * `claude-gpt-6-astra` -- Claude Code's name for the `gpt-6-astra` it routes to -- went out as a
 * codename nobody had catalogued. Nobody had: OpenAI does not ship a Claude GPT, and the half of
 * the name that is real was already known.
 */
const MAKER_WORDS = new Set(MAKERS.flatMap((maker) => maker.words));

/** Whether an ID carries two makers' words, which no maker's own model does. */
/**
 * The word after the maker names one of its clients, or is prose, rather than a family of models.
 *
 * `claude-code-2-1-286` is a release of the CLI and `claude-desktop-3p` is an MCP client
 * identifier; both have the shape of a model and neither is one. The list was living in
 * `claudeCode.ts` and applied only there, so the two readers of the same names disagreed about
 * this.
 */
const CLIENT_WORDS = ["agent", "api", "app", "cli", "code", "desktop", "eval", "sdk", "test"] as const;
/**
 * `claude-powered-preview` is the same prose `claude-4-based` is, one word further in. A stage word
 * where a version belongs widens what the shape accepts, so the word before it has to be a family
 * name and not an adjective; the two lists are the ones already written for suffixes and clients.
 */
const NOT_A_FAMILY = new RegExp(`^(?:${[...CLIENT_WORDS, ...PROSE_WORDS].join("|")})$`);
export function notAModelFamily(id: string): boolean {
  return NOT_A_FAMILY.test(id.split("-")[1] ?? "");
}

/**
 * Two models written as one name, which is what an article's address is when it announces two.
 *
 * `anthropic.com/news/claude-fable-5-mythos-5` announces Fable 5 and Mythos 5. Read as one name it
 * became `claude-fable-5-mythos-5` here and `claude-fable-5-mythos` in the Claude Code reader --
 * two different models, neither of them real, and the second is in production's `records` today.
 *
 * A family word followed by its own version is where the second model starts. A suffix that is not
 * versioned is left alone, so `claude-sonnet-5-5-thinking` stays one name, and so is a dated
 * checkpoint, whose tail is digits rather than a word.
 */
const TWO_MODELS = /^(claude-[a-z]{3,12}-\d+(?:[.-]\d+)*)-([a-z]{3,12}-\d+(?:[.-]\d+)*)$/;
export function splitJoinedModels(id: string): string[] {
  const both = TWO_MODELS.exec(id);
  return both?.[1] && both[2] ? [both[1], `claude-${both[2]}`] : [id];
}

export function crossesMakers(id: string): boolean {
  const makers = new Set(
    id
      .split("-")
      // `qwen3.8` and `deepseek-v4` write the version onto the word; the word is what counts.
      .map((part) => part.replace(/[\d.]+$/, ""))
      .filter((part) => MAKER_WORDS.has(part)),
  );
  return makers.size > 1;
}

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

/** A model ID reduced to its family and suffix: `gemini-3.9-flash` and `gemini-3.6-flash` share one. */
function familyShape(id: string): string | null {
  const shape = /^([a-z][a-z-]*?)-?\d[\d.]*(.*)$/.exec(id);
  return shape ? `${shape[1]}|${shape[2]}` : null;
}

/**
 * The families a test file made up, by naming three versions of one model or more.
 *
 * gemini-cli's `models.test.ts` ran `it.each(['gemini-3.6-flash', 'gemini-3.7-flash',
 * 'gemini-3.9-flash', 'gemini-9.9-flash'])` on 2026-09-22, one id per line, and the scouts were
 * told a Gemini 3.9 Flash exists. A vendor's test naming one model is still a sighting --
 * `gpt-6-astra-wm` first appeared in a Codex test -- so only the invented family is dropped, and
 * only where a test wrote it.
 */
function inventedIn(ids: Iterable<string>): Set<string> {
  const counts = new Map<string, Set<string>>();
  for (const id of ids) {
    const shape = familyShape(id);
    if (shape) counts.set(shape, (counts.get(shape) ?? new Set()).add(id));
  }
  return new Set([...counts].filter(([, found]) => found.size >= 3).map(([shape]) => shape));
}

/** The same reading over a patch's added lines, where a whole file is read by `inventedIn`. */
export function inventedFamilies(patch: string): Set<string> {
  return inventedIn(modelIdsInPatch(patch).keys());
}

/** Model IDs on the added lines of one file's patch, each with the first line that carried it. */
export function modelIdsInPatch(patch: string): Map<string, string> {
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  return modelIdsInLines(added);
}

/**
 * The id a field already holds, told apart from the label sitting in the same column.
 *
 * `MODEL_ID` is for prose, where a family word and a version number are the only shape specific
 * enough to be a model rather than a sentence, and that strictness is right there: `o3` and
 * `gpt-image-2` in a paragraph are as likely to be a release name or an ordinal as a model. A
 * column headed `Model` is the other case entirely -- the maker has already said what the cell is,
 * so the only question left is whether this row names a model or a group of them. On the price
 * page, 49 of the 88 ids in OpenAI's own catalogue cannot be seen by the prose rule: every
 * `gpt-image-*`, `gpt-realtime-*`, `gpt-audio-*`, `gpt-4o*` and the whole o-series.
 *
 * A model is written in lower case by every maker here and carries a digit or a hyphen; the labels
 * that share the column are title case and often two words -- `Whisper`, `Web search`,
 * `Agent Kit`, `File search`, `Containers` were the five non-models among 92 cells on 2026-10-02.
 *
 * A parenthesised note is a variant of the row, not of the model: `gpt-5.5 (<272K context length)`
 * and `o4-mini-2025-04-16 (data sharing)` are the same models as their plain rows at another
 * ceiling or another agreement, so the note is returned beside the id and belongs in the key rather
 * than in the name.
 */
export function modelIdInField(cell: string): { model: string; variant?: string } | null {
  const match = /^([a-z0-9][a-z0-9.-]*)(?:\s*\(([^)]+)\))?$/.exec(cell.trim());
  if (!match) return null;
  const [, model = "", variant] = match;
  if (!/[\d-]/.test(model) || crossesMakers(model)) return null;
  return variant ? { model, variant } : { model };
}

/** Model IDs in prose -- an issue, a comment -- each with the first line that carried it. */
export function modelIdsInText(text: string): Map<string, string> {
  return modelIdsInLines(text.split("\n"));
}

function modelIdsInLines(lines: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of lines) {
    for (const match of line.toLowerCase().matchAll(MODEL_ID)) {
      // A trailing dot is the end of a sentence, not a version.
      const matched = match[0].replace(/[.-]+$/, "");
      if (PROSE_SUFFIX.test(matched) || JOINED.test(matched) || CHECKPOINT.test(matched)) continue;
      if (crossesMakers(matched) || notAModelFamily(matched)) continue;
      for (const id of splitJoinedModels(matched)) if (!found.has(id)) found.set(id, line.trim().slice(0, 240));
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

export function mentionSource(repo: string): string {
  return `github:${repo}:models`;
}

function recordLookup(db: Database): (source: string, id: string) => boolean {
  const query = db.query("SELECT 1 FROM records WHERE source=? AND id=?");
  return (source, id) => Boolean(query.get(source, id));
}

/**
 * Files worth reading on a first read. A repository holds thousands, and a model is named in the
 * few that list, price, configure or test one.
 */
const NAMES_MODELS = /model|catalog|pricing|price|config|constant|registry|provider|client|agent|spec/i;
const READABLE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|json|ya?ml|toml|md|txt)$/i;
/**
 * Somebody else's code, copied in. minimax-code carries `third_party/pi-mono`, whose model list
 * names every model of every maker: it made 131 of the 142 names a first read found, and not one
 * of them is anything MiniMax is doing.
 */
const VENDORED = /(^|\/)(third_party|third-party|vendor|vendored|node_modules|site-packages|\.venv|external|deps)\//i;
/**
 * A family and a version, and nothing after them. In a first read that is the whole of the signal:
 * the file being read is code, and a name with a suffix on it is far more often an identifier the
 * code made up than a model somebody shipped. minimax-code's first read offered `minimax-m3.1`
 * beside `minimax-m3-provider` and `minimax-m3-thinking`, which are a test's provider name and a
 * dedup key. Live sources still report a suffixed codename; only the sweep through old code does not.
 */
const BARE_NAME = new RegExp(`^(?:${FAMILY_SHAPE})$`);
/** A repository larger than this is read from its commits alone; nothing watched here comes close. */
const ARCHIVE_LIMIT = 64 * 1024 * 1024;

/**
 * The files of one gzipped tar, as paths and contents.
 *
 * The archive is one request where opening the files is thousands: minimax-code has 3,988 readable
 * files, and the first version of this read two hundred of them and missed the name it was written
 * for. A tar entry is a 512-byte header -- the path at its start, the size in octal at 124 -- and
 * then its content padded to the next 512. The content is handed back as the archive's own bytes:
 * most of a repository is images and lockfiles, and only the files worth reading are decoded.
 */
function tarEntries(archive: Uint8Array): { path: string; content: Buffer }[] {
  const bytes = Buffer.from(archive);
  const entries: { path: string; content: Buffer }[] = [];
  const field = (header: Buffer, from: number, to: number) =>
    header.subarray(from, to).toString("utf8").replace(/\0.*$/, "");
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    const name = field(header, 0, 100);
    if (!name) break;
    // A path over a hundred bytes is split: the directories go in `prefix` and only the last part
    // in `name`. Reading `name` alone left `list-models.test.ts` with no directory at all, and
    // dropping the archive's own root then emptied it -- which is how the first read of
    // minimax-code found 220 models and not the one it was written for.
    const prefix = field(header, 345, 500);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (!Number.isFinite(size)) break;
    const start = offset + 512;
    // "0" and "\0" are files; a directory, link or long-name entry carries no content worth reading.
    if (/^[0\0]$/.test(header.subarray(156, 157).toString("ascii")))
      entries.push({ path, content: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Every model named in a repository the moment it is first watched, reported as `named`: written
 * into the code, which is what a file can honestly say without a commit message behind it.
 */
async function firstReadNames(
  db: Database,
  repo: string,
  sha: string,
  headers: Record<string, string>,
  request: Fetch,
  watch: MentionWatch,
): Promise<{ records: RecordData[]; scanned: number }> {
  if (watch.talkOnly) return { records: [], scanned: 0 };
  // Nothing but "too large" is let go. This read is the only look at what the repository already
  // holds -- the cursor it sets is the head, and no commit will add those names again -- so an
  // archive that answered 403 or 429, or dropped the connection, fails the collection and the
  // cursor stays unset. It used to end as an empty read, and a name in the code that day was lost.
  const response = await fetchResponse(`https://api.github.com/repos/${repo}/tarball/${sha}`, { headers }, request);
  if (!response.ok) throw httpFailure(`HTTP ${response.status}`, response.status);
  const body = await new Response(readResponseStream(response)).arrayBuffer();
  if (body.byteLength > ARCHIVE_LIMIT) {
    log("warn", "Repository too large to read whole; watched from its commits", { repo });
    return { records: [], scanned: 0 };
  }
  let archive: Uint8Array;
  try {
    archive = Bun.gunzipSync(new Uint8Array(body));
  } catch {
    // A cut-off transfer or an error page under a 200: the next poll asks again.
    throw new SourceError("protocol", `${repo}: the archive is not a gzip stream`);
  }
  const files = tarEntries(archive)
    // The archive's paths are prefixed with a directory named for the commit.
    .map((entry) => ({ ...entry, path: entry.path.split("/").slice(1).join("/") }))
    .filter((entry) => entry.path)
    .filter((entry) =>
      watch.paths
        ? watch.paths.includes(entry.path)
        : READABLE.test(entry.path) && !IGNORED_FILE.test(entry.path) && !VENDORED.test(entry.path),
    )
    .map((entry) => ({ path: entry.path, text: entry.content.toString("utf8") }));
  const records: RecordData[] = [];
  const seen = new Set<string>();
  // A file that lists or prices models is read before one that merely mentions them, so the first
  // sighting of a name carries the most telling path.
  for (const file of [...files].sort(
    (left, right) => Number(NAMES_MODELS.test(right.path)) - Number(NAMES_MODELS.test(left.path)),
  )) {
    const found = modelIdsInText(file.text);
    const invented = isTestFile(file.path) ? inventedIn(found.keys()) : null;
    for (const [id, line] of found) {
      if (seen.has(id) || invented?.has(familyShape(id) ?? "")) continue;
      seen.add(id);
      // A repository names every model it has ever supported, and almost all of them are out. The
      // first read is worth having for the one name nothing else holds -- `MiniMax-M3.1` -- not for
      // the hundred that would arrive with it.
      if (!BARE_NAME.test(id) || stageKnown(db, id, "named") || olderThanKnown(db, id)) continue;
      records.push({
        id,
        name: id,
        model: id,
        stage: "named" satisfies MentionStage,
        ...(watch.vendor ? { maker: watch.vendor } : {}),
        url: `https://github.com/${repo}/blob/${sha}/${file.path}`,
        file: file.path,
        line,
      });
    }
  }
  return { records, scanned: files.length };
}

export async function collectModelMentions(
  db: Database,
  config: AppConfig,
  watch: MentionWatch,
  request: Fetch = fetch,
): Promise<Collection> {
  const source = mentionSource(watch.repo);
  const stored = recordLookup(db);
  const api = `https://api.github.com/repos/${watch.repo}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  const base = { source, stream: "github", url: `https://github.com/${watch.repo}` } as const;
  const cursorRow = db
    .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE source=? AND id=?")
    .get(source, CURSOR);
  const cursor = cursorRow ? (JSON.parse(cursorRow.body) as { sha?: string }).sha : undefined;
  const head = z
    .array(commitSchema)
    .min(1)
    .parse(JSON.parse(await fetchText(`${api}/commits?per_page=1`, headers, request)))[0];
  if (!head) throw new SourceError("empty", `${watch.repo}: no commits`);
  const at = (sha: string): RecordData => ({ id: CURSOR, name: "Last commit read", sha });
  // The first read is the one chance to see what the repository already holds. `MiniMax-M3.1` sat
  // in five files of minimax-code on 2026-09-24 while the catalogue had M3, and starting from the
  // head meant never reporting it: nothing would add that name again. So a repository is read
  // whole when it is first watched, and from its commits ever after.
  if (!cursor) {
    const found = await firstReadNames(db, watch.repo, head.sha, headers, request, watch);
    return {
      ...base,
      raw: { sha: head.sha, scanned: found.scanned },
      records: [at(head.sha), ...found.records],
      silentIds: [CURSOR],
    };
  }
  if (cursor === head.sha) return { ...base, raw: head, records: [at(cursor)], silentIds: [CURSOR] };
  let compare: z.infer<typeof compareSchema>;
  try {
    compare = compareSchema.parse(
      JSON.parse(await fetchText(`${api}/compare/${cursor}...${head.sha}`, headers, request)),
    );
  } catch (error) {
    // The range is gone when history was rewritten under the cursor; read from the head again.
    if (error instanceof SourceHttpError && error.status === 404)
      return { ...base, raw: head, records: [at(head.sha)], silentIds: [CURSOR] };
    throw error;
  }
  // `ahead` is the head having commits the cursor does not, and `diverged` is the same after a
  // rewrite: the commits listed are the ones the head has that the cursor did not either way. Only
  // `behind` and `identical` leave nothing to read. Reading `ahead` alone moved the cursor to the
  // head past a force-push and never looked at what the push brought.
  if (compare.status !== "ahead" && compare.status !== "diverged")
    return { ...base, raw: compare, records: [at(head.sha)], silentIds: [CURSOR] };

  const batch = compare.commits.slice(0, BATCH);
  const records: RecordData[] = [];
  const silentIds = [CURSOR];
  const seen = new Set<string>();
  const raw: unknown[] = [];
  for (const commit of batch) {
    const detail = detailSchema.parse(JSON.parse(await fetchText(`${api}/commits/${commit.sha}`, headers, request)));
    raw.push({ sha: detail.sha, files: detail.files.map((file) => file.filename) });
    const found = new Map<string, { file: string; line: string }>();
    for (const file of detail.files) {
      if (!file.patch || IGNORED_FILE.test(file.filename)) continue;
      if (watch.authority === "third_party" && isTestFile(file.filename)) continue;
      const invented = isTestFile(file.filename) ? inventedFamilies(file.patch) : null;
      if (watch.paths && !watch.paths.includes(file.filename)) continue;
      for (const [id, line] of modelIdsInPatch(file.patch)) {
        if (seen.has(id) || found.has(id)) continue;
        if (invented?.has(familyShape(id) ?? "")) continue;
        // Told at both stages already, or listed by a catalogue: nothing this commit says is news,
        // and there is nothing to ask the judge.
        if (stored(source, id) && stored(source, stageRecordId(id, "served"))) continue;
        if (stageKnown(db, id, "named") && stageKnown(db, id, "served")) continue;
        // A third party writing down an old model is catching up, not early: `gpt-5-image` priced
        // on 2026-09-17 while `gpt-6-astra` was listed. A vendor's own old name can still be news.
        if (watch.authority === "third_party" && olderThanKnown(db, id)) continue;
        // The vendor's own old name is news only while nothing newer of that size is listed:
        // openai-python adding `gpt-5.1-mini` on 2026-09-22 reached the scouts as "named in code"
        // while gpt-5.4-mini was on sale. `gpt-5.6-mini` beside `gpt-6` alone would still be news.
        if (olderThanKnown(db, id, true)) continue;
        found.set(id, { file: file.filename, line });
      }
    }
    if (found.size === 0) continue;
    const text = [detail.commit.message, ...[...found].map(([id, at]) => `${at.file}: ${at.line} [${id}]`)].join("\n");
    const stages = await judgeMentions(config, request, "commit", text, [...found.keys()], { db, source });
    for (const [id, at] of found) {
      const stage: MentionStage = stages.get(id) ?? "named";
      const recordId = stageRecordId(id, stage);
      if (stored(source, recordId)) continue;
      seen.add(id);
      records.push({
        id: recordId,
        name: stage === "served" ? `${id} served` : id,
        model: id,
        stage,
        ...(watch.vendor ? { maker: watch.vendor } : {}),
        url: detail.html_url,
        commit: detail.commit.message.split("\n")[0]?.trim() || detail.sha,
        ...(detail.commit.author?.date ? { committed: detail.commit.author.date } : {}),
        file: at.file,
        line: at.line,
      });
      if (stageKnown(db, id, stage)) silentIds.push(recordId);
    }
  }
  const last = batch.at(-1)?.sha ?? head.sha;
  return { ...base, raw, records: [at(last), ...records], silentIds };
}
