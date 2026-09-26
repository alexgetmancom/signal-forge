import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { type BundleMemory, forgetful } from "./bundleMemory.js";
import { scanGzipStream } from "./gzipScan.js";

const TAGS = "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags";
const BINARY = "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-";

/**
 * Model ids written into the Claude Code binary. Aliases and cloud spellings of a known id
 * ("-v1", "-0", a date) are the same model; "claude-eval-9" and "claude-desktop-3p" are not models.
 */
export function claudeModelIds(text: string): string[] {
  return [...collectIds(new Set(), text)].sort();
}

function collectIds(ids: Set<string>, text: string): Set<string> {
  for (const [id] of text.matchAll(/\bclaude-(?:opus|sonnet|haiku|[a-z]{3,12})-\d+(?:[-.]\d+)?(?:-[a-z]+)?\b/g)) {
    if (/^claude-(?:eval|desktop|code|cli|test|api|agent|sdk|app)-/.test(id)) continue;
    if (/-(?:v\d|0|\d{8})$/.test(id)) continue;
    ids.add(id);
  }
  return ids;
}

/**
 * The models the Claude Code client ships knowing about. A model name reaches the client before
 * anyone announces it, as a slug reaches the Codex model list. Only a new release is downloaded,
 * and it is scanned as it arrives rather than held: 103.5 MB compressed and 230.4 MB unpacked on
 * 2026-09-26, which read whole was the largest single cost this service had.
 */
export async function collectClaudeCodeModels(
  request: Fetch = fetch,
  memory: BundleMemory = forgetful,
): Promise<Collection> {
  const tags = (await (await request(TAGS)).json()) as Record<string, string>;
  const version = tags.next ?? tags.latest;
  if (!version) throw new Error("Claude Code has no published version");
  // The version has not moved, so the 230 MB it would take to learn nothing is not spent.
  if (memory.lastVersion() === version) {
    const known = memory.ids();
    if (known.length) return collection(version, known);
  }
  const response = await request(`${BINARY}${version}.tgz`);
  if (!response.ok) throw new Error(`Claude Code ${version} binary: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Claude Code ${version} binary: no body`);
  const found = new Set<string>();
  await scanGzipStream(response.body, (text) => collectIds(found, text));
  const ids = [...found].sort();
  if (!ids.length) throw new Error(`Claude Code ${version} names no model`);
  memory.remember(version);
  return collection(version, ids);
}

function collection(version: string, ids: readonly string[]): Collection {
  return {
    source: "claude-code-models",
    stream: "github",
    url: `https://www.npmjs.com/package/@anthropic-ai/claude-code/v/${version}`,
    raw: ids.join("\n"),
    records: ids.map((id) => ({ id, name: id, maker: "Anthropic" })),
  };
}
