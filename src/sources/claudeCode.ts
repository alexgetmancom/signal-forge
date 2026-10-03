import type { Collection } from "../events/types.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { type BundleMemory, forgetful } from "./bundleMemory.js";
import { scanGzipStream } from "./gzipScan.js";
import { notAModelFamily, splitJoinedModels } from "./modelMentions.js";
import { publishedVersion } from "./npmVersion.js";

const PACKAGE = "@anthropic-ai/claude-code";
/** Claude Code ships to `next` first, which is the channel a new model id arrives on. */
const CHANNELS = ["next", "latest"];
const BINARY = "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-";

/**
 * Model ids written into the Claude Code binary. Aliases and cloud spellings of a known id
 * ("-v1", "-0", a date) are the same model; "claude-eval-9" and "claude-desktop-3p" are not models.
 */
export function claudeModelIds(text: string): string[] {
  return [...collectIds(new Set(), text)].sort();
}

/**
 * `preview` is a stage, not a suffix of a version: `claude-mythos-preview` is in this binary and was
 * invisible here, because the shape demanded a digit after the family word. It reached us eight days
 * later through `anthropic-deprecations` instead, which is the whole lead time this source exists
 * to buy.
 */
function collectIds(ids: Set<string>, text: string): Set<string> {
  for (const [id] of text.matchAll(
    // A word after the version may carry a version of its own, so that a name holding a second model
    // arrives whole and `splitJoinedModels` can see both: cut before it, `claude-fable-5-mythos-5`
    // became `claude-fable-5-mythos`, a model nobody ships, and that is what production stored. The
    // version itself stays two levels deep, which is what reads `claude-sonnet-4-5-20250929` as the
    // alias it is a checkpoint of rather than swallowing the date.
    /\bclaude-(?:opus|sonnet|haiku|[a-z]{3,12})-(?:\d+(?:[-.]\d+)?(?:-[a-z]+(?:[-.]\d+)?)?|preview|alpha|beta)\b/g,
  )) {
    if (notAModelFamily(id)) continue;
    if (/-(?:v\d|0|\d{8})$/.test(id)) continue;
    for (const one of splitJoinedModels(id)) ids.add(one);
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
  const version = await publishedVersion(PACKAGE, CHANNELS, request);
  if (!version) throw new SourceError("empty", "Claude Code has no published version");
  // The version has not moved, so the 230 MB it would take to learn nothing is not spent.
  if (memory.lastVersion() === version) {
    const known = memory.ids();
    if (known.length) return collection(version, known);
  }
  const response = await request(`${BINARY}${version}.tgz`);
  if (!response.ok) throw httpFailure(`Claude Code binary: HTTP ${response.status}`, response.status);
  if (!response.body) throw new SourceError("protocol", `Claude Code binary: no body`);
  const found = new Set<string>();
  await scanGzipStream(response.body, (text) => collectIds(found, text));
  const ids = [...found].sort();
  if (!ids.length) throw new SourceError("missing-content", `Claude Code names no model`);
  memory.remember(version);
  return collection(version, ids);
}

/**
 * Whether the published version is the one already read through, asked without downloading it.
 * The poller calls this every few minutes and only spends the 230 MB when it answers false.
 */
export async function claudeCodeUnchanged(request: Fetch = fetch, memory: BundleMemory = forgetful): Promise<boolean> {
  const version = await publishedVersion(PACKAGE, CHANNELS, request);
  return version !== null && memory.lastVersion() === version && memory.ids().length > 0;
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
