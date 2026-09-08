import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
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
export async function collectClaude(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const html = await fetchText("https://claude.ai", {}, request);
  const entry = assetSchema.parse(
    html.match(/<script[^>]+src="(https:\/\/assets-proxy\.anthropic\.com\/[^"]+\.js)"/)?.[1],
  );
  const code = await fetchText(entry, {}, request, undefined, cache);
  const raw: Record<string, string> = { [entry]: code };
  let bytes = code.length;
  const queued = claudeAssetImports(code, entry).map((url) => ({ url, depth: 1 }));
  const seen = new Set([entry, ...queued.map((item) => item.url)]);
  // Two levels include feature chunks omitted by the entry bundle without traversing the entire vendor graph.
  for (let i = 0; i < queued.length; i += 4) {
    const batch = await Promise.all(
      queued
        .slice(i, i + 4)
        .map(async (item) => ({ ...item, code: await fetchText(item.url, {}, request, undefined, cache) })),
    );
    for (const asset of batch) {
      bytes += asset.code.length;
      if (bytes > 150_000_000) throw new Error("Public page Claude assets exceed 150 MB limit");
      raw[asset.url] = asset.code;
      if (asset.depth >= 2) continue;
      for (const url of claudeAssetImports(asset.code, asset.url)) {
        if (seen.has(url)) continue;
        seen.add(url);
        queued.push({ url, depth: asset.depth + 1 });
        if (seen.size > 1200) throw new Error("Public page Claude asset graph exceeds 1200 files at depth 2");
      }
    }
  }
  const strings = [...new Set(Object.values(raw).flatMap(extractStrings))].sort();
  if (!strings.length) throw new Error("Public page Claude strings not found");
  return {
    source: "claude-web",
    stream: "web",
    url: "https://claude.ai",
    raw,
    records: [{ id: "public-entry-strings", name: "Claude: public interface strings", strings }],
  };
}
