import type { Fetch } from "../delivery.js";
import { freshUntil, type HttpCache } from "../storage/httpCache.js";

export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  request: Fetch = fetch,
  // Some catalogues only answer a POST/PUT with a filter body; the retry, redirect and size rules
  // are the same, so the verb is a parameter rather than a second copy of this function.
  send?: { method: string; body: string },
  // When a cache is supplied the request becomes conditional: a page that has not changed answers
  // 304 with no body, and an immutable asset is not requested at all.
  cache?: HttpCache,
): Promise<string> {
  let response: Response | undefined;
  const origin = new URL(url).origin;
  const cached = send ? null : (cache?.get(url) ?? null);
  if (cached && cached.freshUntil > Date.now()) {
    cache?.touch(url, cached.freshUntil);
    return cached.body;
  }
  const conditional: Record<string, string> = {};
  if (cached?.etag) conditional["if-none-match"] = cached.etag;
  else if (cached?.lastModified) conditional["if-modified-since"] = cached.lastModified;
  for (let hop = 0; hop < 4; hop++) {
    response = await request(url, {
      headers: { "User-Agent": "SignalForge/0.1", ...conditional, ...headers },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
      ...(send ? { method: send.method, body: send.body } : {}),
    });
    // 304 shares the 3xx range but is an answer, not a redirect: it means the cached body stands.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Source redirect missing location");
      const next = new URL(location, url);
      if (next.origin !== origin) throw new Error("Source redirect changed origin");
      url = next.href;
      continue;
    }
    break;
  }
  if (!response) throw new Error("Source returned no response");
  if (response.status === 304 && cached) {
    await response.body?.cancel();
    cache?.touch(url, freshUntil(response.headers.get("cache-control")));
    return cached.body;
  }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Source returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20_000_000) throw new Error("Source exceeds 20 MB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  const reusableUntil = freshUntil(response.headers.get("cache-control"));
  // A body worth storing is one we can ask about later. Without a validator the next observation
  // downloads it again regardless, so keeping a copy would be weight with no saving.
  //
  // `learn.chatgpt.com` is the case in point: it returns no validator on GET, and its ETag on HEAD
  // comes and goes with the edge cache. A HEAD probe was implemented, measured (298 requests
  // instead of 149, no 304s) and removed.
  if (cache && !send && (etag || lastModified || reusableUntil > 0))
    cache.put(url, { etag, lastModified, freshUntil: reusableUntil, body: text });
  return text;
}
