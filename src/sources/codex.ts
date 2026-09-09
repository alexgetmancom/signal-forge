import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

export function codexPages(index: string): { name: string; url: string }[] {
  const pages = new Map<string, { name: string; url: string }>();
  for (const match of index.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)) {
    const url = new URL(match[2] ?? "");
    if (
      url.origin !== "https://learn.chatgpt.com" ||
      !url.pathname.startsWith("/docs/") ||
      !url.pathname.endsWith(".md")
    )
      continue;
    if (url.pathname.endsWith("codex-manual.md")) continue; // Generated duplicate of individual guides.
    pages.set(url.href, { name: match[1] ?? url.pathname, url: url.href });
  }
  if (!pages.size || pages.size > 200) throw new Error("Public page Codex index invalid or exceeds 200 pages");
  return [...pages.values()].sort((a, b) => a.url.localeCompare(b.url));
}
export function markdownParagraphs(text: string): string[] {
  if (!text.trimStart().startsWith("# ") || /<!doctype html/i.test(text))
    throw new Error("Public page expected Markdown");
  return text
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s && !s.startsWith("> For the complete documentation index"));
}
export async function collectCodexDocs(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const index = await fetchText("https://learn.chatgpt.com/docs/llms.txt", {}, request, undefined, cache);
  const pages = codexPages(index);
  const records: Collection["records"] = [];
  const raw: Record<string, string> = { index };
  let bytes = index.length;
  // A failed page aborts the entire observation; it cannot imply deleted documentation.
  for (let offset = 0; offset < pages.length; offset += 4) {
    const results = await Promise.all(
      pages.slice(offset, offset + 4).map(async (page) => {
        const text = await fetchText(page.url, {}, request, undefined, cache);
        return { page, text, strings: markdownParagraphs(text) };
      }),
    );
    for (const { page, text, strings } of results) {
      bytes += text.length;
      if (bytes > 15_000_000) throw new Error("Public page Codex documentation exceeds 15 MB");
      raw[page.url] = text;
      records.push({ id: page.url, name: page.name, url: page.url.replace(/\.md(?=\?|$)/, ""), strings });
    }
  }
  return { source: "codex-docs", stream: "web", url: "https://developers.openai.com/codex/", records, raw };
}
