import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { markdownText, publishedDate } from "./feeds.js";
import { fetchText } from "./http.js";

/**
 * Google Antigravity: the agent-first platform the Gemini CLI is being folded into.
 *
 * "An important update: Transitioning Gemini CLI to Antigravity CLI", 2026-05-19, moves the
 * consumer and free routes here from 2026-06-18 while keeping Enterprise Code Assist and paid API
 * keys on the old client. So this is not a replacement for `gemini-cli-models`, which was still
 * publishing 0.62.0 on 2026-10-04 and still names twenty-two model ids; it is the surface the
 * maker is now pouring its coding work into, and nothing here was reading it.
 *
 * Three reads, none of them heavy:
 *
 * - the auto-updater manifest, which is 303 bytes and names the build before the changelog does.
 *   On 2026-10-04 the two manifests said 1.2.16 and the published changelog stopped at 1.2.14.
 * - the changelog, as its own Markdown, which carries every surface: app, CLI, SDK and IDE.
 * - the models page, as its own Markdown, which is a plan matrix rather than a catalogue: which
 *   model a tier may select inside the IDE, including the ones Google does not make.
 *
 * The CLI's own binary is deliberately not downloaded. It is a single 200 MB Go executable whose
 * strings are run together -- `gemini-3.8-flashgemini-3.7-flash` -- so the quoted-id pattern in
 * ./cliBundles.ts reads zero from it, and `desktop.ts` already measured what a client bundle buys
 * over a catalogue: nothing, at 600 MB a version. The manifest is the build, and the build is what
 * is worth having.
 */
const MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const CHANGELOG_MARKDOWN_URL = "https://antigravity.google/docs/changelog.md";
const CHANGELOG_URL = "https://antigravity.google/docs/changelog/";
const MODELS_MARKDOWN_URL = "https://antigravity.google/docs/models.md";
const MODELS_URL = "https://antigravity.google/docs/models/";

/** The platforms the updater publishes a manifest for, each one build of one release. */
const PLATFORMS = ["darwin_arm64", "linux_amd64"] as const;

const manifestSchema = z.object({
  version: z.string().min(1),
  url: z.string().min(1),
  sha512: z.string().min(1),
});

/**
 * What the CLI's auto-updater offers, one record per platform.
 *
 * The download URL and the digest are not stored. They are upstream values, and what is being
 * asked here is which build exists, not where to get it; a path that moves is a change nobody
 * wants an event for.
 */
export async function collectAntigravityBuild(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const records: RecordData[] = [];
  const bodies: string[] = [];
  for (const platform of PLATFORMS) {
    const body = await fetchText(
      `${MANIFEST_BASE}/${platform}.json`,
      { accept: "application/json" },
      request,
      undefined,
      cache,
    );
    bodies.push(body);
    const manifest = manifestSchema.parse(JSON.parse(body) as unknown);
    records.push({
      id: `antigravity-cli:${platform}`,
      name: `Antigravity CLI ${manifest.version} (${platform})`,
      maker: "Google",
      url: CHANGELOG_URL,
      version: manifest.version,
      platform,
    });
  }
  if (!records.length) throw new SourceError("empty", "antigravity-cli-build: no platform manifest answered");
  return {
    source: "antigravity-cli-build",
    stream: "packages",
    url: CHANGELOG_URL,
    raw: bodies.join("\n"),
    trackChanges: true,
    records,
  };
}

/** `## Antigravity CLI` and its siblings: which surface the versions beneath a heading belong to. */
const SURFACE = /^##\s+([^\n]+)$/gm;
/** `### [v2.19.1](/releases?tab=hub&version=2.19.1 "...")` -- the version and nothing around it. */
const VERSION = /^###\s+\[v([0-9][^\]\s]*)\]\(/gm;

export function parseAntigravityChangelog(markdown: string): Collection {
  const surfaces = [...markdown.matchAll(SURFACE)];
  const records = [...markdown.matchAll(VERSION)].map((match) => {
    const version = match[1] ?? "";
    const at = match.index ?? 0;
    const surface =
      surfaces
        .filter((heading) => (heading.index ?? 0) < at)
        .at(-1)?.[1]
        ?.trim() ?? "Antigravity";
    // From the end of the heading's line rather than the end of the match, so the rest of the
    // release link -- `/releases?tab=hub&version=2.19.1 "...")` -- is not read as the first line of
    // the entry and does not end up inside the stored summary.
    const from = markdown.indexOf("\n", at);
    const body = from < 0 ? "" : markdown.slice(from + 1, nextEntry(markdown, from + 1));
    // The date is the first line under the version that reads as one; "Latest" sits above it on the
    // newest entry, so the lines are tried in order rather than counted.
    const published = firstDate(body);
    return {
      id: `antigravity:${surface.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}:${version}`,
      name: `${surface} ${version}`,
      maker: "Google",
      url: CHANGELOG_URL,
      version,
      surface,
      ...(published ? { published } : {}),
      summary: markdownText(body).slice(0, 1_200),
    } satisfies RecordData;
  });
  if (!records.length)
    throw new SourceError("missing-content", "antigravity-changelog: no versioned entries in the changelog");
  return {
    source: "antigravity-changelog",
    stream: "news",
    url: CHANGELOG_URL,
    raw: markdown,
    trackChanges: true,
    records,
  };
}

/**
 * Where the entry whose body starts at `from` stops: the next version, the next surface, or the end.
 *
 * Both patterns require the newline rather than leaning on `^` under `/m`, because the body starts
 * in the middle of the heading it belongs to: what remains of `### [v2.19.1](` is `## [v2.19.1](`,
 * which `^##\s+\S` matched at offset zero. Every entry then came out empty -- no date, no summary,
 * 136 of them -- and an empty summary is not a shape any schema refuses.
 */
function nextEntry(markdown: string, from: number): number {
  const rest = markdown.slice(from);
  const ends = [/\n###\s+\[v[0-9]/, /\n##\s+\S/]
    .map((pattern) => rest.search(pattern))
    .filter((index) => index >= 0)
    .map((index) => from + index);
  return ends.length ? Math.min(...ends) : markdown.length;
}

function firstDate(body: string): string | null {
  for (const line of body.split("\n").slice(0, 6)) {
    const text = line.trim();
    if (!text) continue;
    try {
      return publishedDate(text);
    } catch {}
  }
  return null;
}

export async function collectAntigravityChangelog(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseAntigravityChangelog(await fetchText(CHANGELOG_MARKDOWN_URL, {}, request, undefined, cache));
}

/** A row of the plan matrix: one model, and the tiers that may select it. */
const MODEL_ROW = /^\|\s*(?:\[)?([^|\]]+?)(?:\]\([^)]*\))?\s*\|([^\n]*)\|\s*$/gm;
/** The header row and its underline are not models, and neither is a cell of dashes. */
const NOT_A_MODEL = /^(?:model|-{2,}|\s*)$/i;

/**
 * Which model each plan may select inside Antigravity.
 *
 * This is an availability matrix, not a catalogue: it carries Claude and GPT-OSS beside Gemini,
 * because what it answers is what the IDE will let a tier choose. A model leaving a column is the
 * signal -- the page carried "Will be removed on November 2, 2026" against two Claude rows on
 * 2026-10-04 -- so the tiers are stored and `trackChanges` is on.
 */
export function parseAntigravityModels(markdown: string): Collection {
  const header = MODEL_ROW.exec(markdown);
  MODEL_ROW.lastIndex = 0;
  const tiers = header
    ? (header[2] ?? "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
    : [];
  const records = [...markdown.matchAll(MODEL_ROW)].flatMap((match) => {
    // `Claude Opus 5.5 (thinking)\*\*` -- the asterisks are a footnote about the plan, not the name.
    const name = (match[1] ?? "").replaceAll("\\", "").replace(/\*+$/, "").trim();
    if (NOT_A_MODEL.test(name)) return [];
    const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
    const plans = tiers.flatMap((tier, index) => (cells[index]?.startsWith("✅") ? [tier] : []));
    if (!plans.length && !cells.some((cell) => cell.startsWith("❌"))) return [];
    return [
      {
        id: `antigravity-model:${name.toLowerCase().replaceAll(/[^a-z0-9.]+/g, "-")}`,
        name,
        maker: "Google",
        url: MODELS_URL,
        plans,
      } satisfies RecordData,
    ];
  });
  if (!records.length) throw new SourceError("missing-content", "antigravity-models: the plan matrix named no models");
  return {
    source: "antigravity-models",
    stream: "web",
    url: MODELS_URL,
    raw: markdown,
    trackChanges: true,
    records,
  };
}

export async function collectAntigravityModels(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseAntigravityModels(await fetchText(MODELS_MARKDOWN_URL, {}, request, undefined, cache));
}
