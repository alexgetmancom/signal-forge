import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
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
export async function collectClaude(request: Fetch = fetch): Promise<Collection> {
  const html = await fetchText("https://claude.ai", {}, request);
  const entry = assetSchema.parse(
    html.match(/<script[^>]+src="(https:\/\/assets-proxy\.anthropic\.com\/[^"]+\.js)"/)?.[1],
  );
  const code = await fetchText(entry, {}, request);
  const imports = [
    ...new Set(
      [...code.matchAll(/from\s*"(\.\/[^"?]+\.js)"/g)].map((m) => assetSchema.parse(new URL(m[1] ?? "", entry).href)),
    ),
  ];
  if (imports.length > 80) throw new Error("Public page Claude import count exceeds limit");
  const raw: Record<string, string> = { [entry]: code };
  let bytes = code.length;
  // Only the public entry and its direct imports. A failed asset invalidates the whole observation.
  for (let i = 0; i < imports.length; i += 4) {
    const batch = await Promise.all(
      imports.slice(i, i + 4).map(async (url) => ({ url, code: await fetchText(url, {}, request) })),
    );
    for (const asset of batch) {
      bytes += asset.code.length;
      if (bytes > 50_000_000) throw new Error("Public page Claude assets exceed 50 MB limit");
      raw[asset.url] = asset.code;
    }
  }
  const strings = [...new Set(Object.values(raw).flatMap(extractStrings))].sort();
  if (!strings.length) throw new Error("Public page Claude strings not found");
  return {
    source: "claude-web",
    stream: "web",
    url: "https://claude.ai",
    raw,
    records: [{ id: "public-entry-strings", name: "Claude: строки публичного интерфейса", strings }],
  };
}
