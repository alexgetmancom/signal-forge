import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";

const TAGS = "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags";
const BINARY = "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-";

/**
 * Model ids written into the Claude Code binary. Aliases and cloud spellings of a known id
 * ("-v1", "-0", a date) are the same model; "claude-eval-9" and "claude-desktop-3p" are not models.
 */
export function claudeModelIds(text: string): string[] {
  const ids = new Set<string>();
  for (const [id] of text.matchAll(/\bclaude-(?:opus|sonnet|haiku|[a-z]{3,12})-\d+(?:[-.]\d+)?(?:-[a-z]+)?\b/g)) {
    if (/^claude-(?:eval|desktop|code|cli|test|api|agent|sdk|app)-/.test(id)) continue;
    if (/-(?:v\d|0|\d{8})$/.test(id)) continue;
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The models the Claude Code client ships knowing about. A model name reaches the client before
 * anyone announces it, as a slug reaches the Codex model list. Only a new release is downloaded;
 * the tarball is read in memory and not kept.
 */
let read: { version: string; collection: Collection } | null = null;

export async function collectClaudeCodeModels(request: Fetch = fetch): Promise<Collection> {
  const tags = (await (await request(TAGS)).json()) as Record<string, string>;
  const version = tags.next ?? tags.latest;
  if (!version) throw new Error("Claude Code has no published version");
  if (read?.version === version) return read.collection;
  const response = await request(`${BINARY}${version}.tgz`);
  if (!response.ok) throw new Error(`Claude Code ${version} binary: HTTP ${response.status}`);
  const text = Buffer.from(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))).toString("latin1");
  const ids = claudeModelIds(text);
  if (!ids.length) throw new Error(`Claude Code ${version} names no model`);
  const collection: Collection = {
    source: "claude-code-models",
    stream: "github",
    url: `https://www.npmjs.com/package/@anthropic-ai/claude-code/v/${version}`,
    raw: ids.join("\n"),
    records: ids.map((id) => ({ id, name: id, maker: "Anthropic" })),
  };
  read = { version, collection };
  return collection;
}
