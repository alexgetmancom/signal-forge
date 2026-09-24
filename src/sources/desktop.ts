import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { claudeModelIds } from "./claudeCode.js";

/**
 * The desktop clients, which this tracker had never opened.
 *
 * Everything here is read from the address the vendor's own download page links, with no login and
 * nothing bypassed. The two pages that do ask a question -- `claude.ai/api/desktop/...` and
 * `chatgpt.com/download` -- answer 403 to a robot, and are left alone; what follows are the files
 * they eventually hand a browser, served openly from a CDN.
 */

/**
 * Anthropic ships a second desktop app, and says so in a 700-byte file.
 *
 * `downloads.claude.ai/claude-science/latest/manifest.json` carries the version, the commit and the
 * build date of Claude Science, and was written on 2026-09-22 at 23:17 UTC for 0.1.52. Nothing this
 * tracker reads mentions the product at all. The manifest is the cheapest release signal available
 * anywhere here: a version bump is a shipped build of an Anthropic client, known within minutes.
 */
const SCIENCE_MANIFEST = "https://downloads.claude.ai/claude-science/latest/manifest.json";

/**
 * The same build as one runnable file, so the models it knows about can be read the way Claude
 * Code's are. Its list lags the API -- on 2026-09-24 it stopped at `claude-opus-5` while
 * `claude-opus-5-5` had been out two days -- so the binary is read for the record, not for the
 * lead, and only when the version has actually moved.
 */
const SCIENCE_BINARY = "https://downloads.claude.ai/claude-science/latest/linux-x64";

const manifestSchema = z.object({
  version: z.string().min(1),
  sha8: z.string().min(1).nullish(),
  buildDate: z.string().min(1).nullish(),
});

let readScience: { version: string; models: string[] } | null = null;

export async function collectClaudeScience(request: Fetch = fetch): Promise<Collection> {
  const response = await request(SCIENCE_MANIFEST);
  if (!response.ok) throw new Error(`Claude Science manifest: HTTP ${response.status}`);
  const manifest = manifestSchema.parse(await response.json());
  if (readScience?.version !== manifest.version) {
    const binary = await request(SCIENCE_BINARY);
    if (!binary.ok) throw new Error(`Claude Science ${manifest.version} binary: HTTP ${binary.status}`);
    const models = claudeModelIds(Buffer.from(await binary.arrayBuffer()).toString("latin1"));
    if (!models.length) throw new Error(`Claude Science ${manifest.version} names no model`);
    readScience = { version: manifest.version, models };
  }
  const record: RecordData = {
    id: "claude-science",
    name: "Claude Science",
    maker: "Anthropic",
    version: manifest.version,
    built: manifest.buildDate ?? null,
    commit: manifest.sha8 ?? null,
    models: readScience.models,
    url: "https://claude.com/download",
  };
  return {
    source: "claude-science-desktop",
    stream: "apps",
    url: SCIENCE_MANIFEST,
    raw: manifest,
    records: [record],
  };
}

/**
 * The products Anthropic has a download for.
 *
 * `claude-science` sits under `downloads.claude.ai/<product>/latest/manifest.json`, and a product
 * that does not exist answers 404 there. A second slug appearing is a desktop application Anthropic
 * has built and not yet announced, which is the same bet the documentation probes make and costs
 * the same: a handful of 404s a poll.
 */
const CLAUDE_PRODUCTS = [
  "claude-science",
  "claude-desktop",
  "claude-code",
  "claude-cowork",
  "claude-research",
  "claude-agent",
  "claude-labs",
  "claude-studio",
  "claude-notebook",
] as const;

export async function collectClaudeDownloads(request: Fetch = fetch): Promise<Collection> {
  const records: RecordData[] = [];
  const tried: Record<string, number> = {};
  for (const product of CLAUDE_PRODUCTS) {
    const url = `https://downloads.claude.ai/${product}/latest/manifest.json`;
    const response = await request(url).catch(() => null);
    if (!response) continue;
    tried[product] = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      continue;
    }
    const manifest = manifestSchema.safeParse(await response.json());
    if (!manifest.success) continue;
    records.push({
      id: product,
      name: product,
      maker: "Anthropic",
      version: manifest.data.version,
      built: manifest.data.buildDate ?? null,
      url: "https://claude.com/download",
    });
  }
  if (!records.length) throw new Error("no Anthropic download manifest answered, not even Claude Science");
  return {
    source: "discovery:claude-downloads",
    stream: "apps",
    url: "https://downloads.claude.ai",
    raw: tried,
    appendOnly: true,
    records,
  };
}

/**
 * OpenAI's Mac client, which says when it was built and nothing else.
 *
 * The app's own binary names no model -- checked on the 2026-07-09 build, `1.2026.183`, which
 * carries not one model id, because it asks the API at runtime. So only the build is observable,
 * and it is observable without downloading 78 MB: the CDN's own headers date the file. This is a
 * "they shipped" signal, not a model sighting.
 */
const CHATGPT_DMG = "https://persistent.oaistatic.com/sidekick/public/ChatGPT.dmg";

export async function collectChatGptDesktop(request: Fetch = fetch): Promise<Collection> {
  const response = await request(CHATGPT_DMG, { method: "HEAD" });
  if (!response.ok) throw new Error(`ChatGPT desktop: HTTP ${response.status}`);
  const built = response.headers.get("last-modified");
  const bytes = Number(response.headers.get("content-length") ?? "0");
  if (!built || !bytes) throw new Error("ChatGPT desktop: the CDN gave no build date");
  return {
    source: "chatgpt-desktop",
    stream: "apps",
    url: "https://chatgpt.com/download",
    raw: { built, bytes },
    records: [
      {
        id: "chatgpt-macos",
        name: "ChatGPT for macOS",
        maker: "OpenAI",
        built: new Date(built).toISOString(),
        bytes,
        url: "https://chatgpt.com/download",
      },
    ],
  };
}
