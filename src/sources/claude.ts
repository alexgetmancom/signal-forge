import { z } from "zod";
import type { Collection } from "../events/types.js";
import { selectMeaningfulWebStrings } from "../events/web.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

const assetSchema = z.url().refine((value) => {
  const u = new URL(value);
  return (
    u.origin === "https://assets-proxy.anthropic.com" &&
    u.pathname.startsWith("/claude-ai/") &&
    u.pathname.endsWith(".js")
  );
}, "Unexpected Claude asset URL");
export function extractStrings(code: string): string[] {
  const values = new Set<string>();
  for (const match of code.matchAll(/defaultMessage\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    const value = z.string().parse(JSON.parse(match[1] ?? '""'));
    if (value.trim()) values.add(value);
  }
  return [...values].sort();
}
export function claudeAssetImports(code: string, parent: string): string[] {
  const urls = new Set<string>();
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\.?\/[^"'?]+\.js)["']/g))
    urls.add(assetSchema.parse(new URL(match[1] ?? "", parent).href));
  return [...urls];
}

/** Keep the strings and graph edges; release each JavaScript body before retaining the next batch. */
async function readClaudeAsset(url: string, depth: number, request: Fetch, cache?: HttpCache) {
  const code = await fetchText(url, {}, request, undefined, cache);
  return {
    url,
    depth,
    bytes: Buffer.byteLength(code),
    strings: extractStrings(code),
    imports: depth < 2 ? claudeAssetImports(code, url) : [],
  };
}

export async function collectClaude(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const html = await fetchText("https://claude.ai", {}, request);
  const entry = assetSchema.parse(
    html.match(/<script[^>]+src="(https:\/\/assets-proxy\.anthropic\.com\/[^"]+\.js)"/)?.[1],
  );
  const first = await readClaudeAsset(entry, 0, request, cache);
  const raw: Record<string, string[]> = { [entry]: first.strings };
  let bytes = first.bytes;
  const queued = first.imports.map((url) => ({ url, depth: 1 }));
  const seen = new Set([entry, ...queued.map((item) => item.url)]);
  if (seen.size > 1200)
    throw new SourceError("protocol", "Public page Claude asset graph exceeds 1200 files at depth 2");
  // Two levels include feature chunks omitted by the entry bundle without traversing the entire vendor graph.
  for (let i = 0; i < queued.length; ) {
    const batch = await Promise.allSettled(
      queued.slice(i, i + 4).map((item) => readClaudeAsset(item.url, item.depth, request, cache)),
    );
    const failure = batch.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    for (const result of batch) {
      if (result.status !== "fulfilled") continue;
      const asset = result.value;
      bytes += asset.bytes;
      if (bytes > 150_000_000) throw new SourceError("protocol", "Public page Claude assets exceed 150 MB limit");
      raw[asset.url] = asset.strings;
      for (const url of asset.imports) {
        if (seen.has(url)) continue;
        seen.add(url);
        queued.push({ url, depth: asset.depth + 1 });
        if (seen.size > 1200)
          throw new SourceError("protocol", "Public page Claude asset graph exceeds 1200 files at depth 2");
      }
    }
    i += batch.length;
  }
  const strings = selectMeaningfulWebStrings(Object.values(raw).flat());
  if (!strings.length) throw new SourceError("missing-content", "Public page Claude strings not found");
  return {
    source: "claude-web",
    stream: "web",
    url: "https://claude.ai",
    raw,
    records: [{ id: "public-entry-strings", name: "Claude: public interface strings", strings }],
  };
}
