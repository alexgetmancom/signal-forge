import type { Fetch } from "../http-client.js";
import { freshUntil, type HttpCache } from "../storage/httpCache.js";

/** How long the channel is given to come back before an observation is called a failure. */
export const RETRY_DELAYS_MS = [3_000, 9_000];

export class SourceHttpError extends Error {
  constructor(
    message: string,
    readonly retryAt: string | null = null,
    /** The status is kept because 401 and 403 are a refused credential, not a flaky link. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

function retryAt(headers: Headers, now = Date.now()): string | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(time) && time > now) return new Date(time + 1000).toISOString();
  }
  const window = headers.get("ratelimit")?.match(/(?:^|;)\s*t=(\d+)/i)?.[1];
  if (window) return new Date(now + Number(window) * 1000 + 1000).toISOString();
  const reset = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset * 1000 > now ? new Date(reset * 1000 + 1000).toISOString() : null;
}

/**
 * The link this collector runs on drops for minutes at a time — measured: every OpenAI and
 * Anthropic host failed its TLS handshake for seven minutes and then recovered untouched. A single
 * attempt turns that into a failed source, a red board and an alert about a service that was never
 * broken. Two retries cover the outages actually seen; anything longer is a real outage and should
 * be reported as one.
 *
 * Only transport failures and the server's own "try again" codes are retried. A 4xx is an answer,
 * and repeating a request the server already refused is how a collector earns a rate limit.
 */
async function attempt(url: string, request: Fetch, init: RequestInit, delays: readonly number[]): Promise<Response> {
  let last: unknown;
  for (let index = 0; ; index++) {
    try {
      const response = await request(url, { ...init, signal: AbortSignal.timeout(30_000) });
      // 429 is deliberately absent: it is the server saying "too many", and answering that with
      // another request three seconds later is the opposite of what it asked for. The per-source
      // backoff handles it by asking later instead.
      if (![502, 503, 504].includes(response.status) || index >= delays.length) return response;
      await response.body?.cancel();
      last = new Error(`Source returned HTTP ${response.status}`);
    } catch (error) {
      last = error;
      if (index >= delays.length) break;
    }
    await new Promise((resolve) => setTimeout(resolve, delays[index]));
  }
  throw last;
}

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
  // The retry schedule is a parameter so a test can measure the policy instead of the clock: what
  // the retry rules promise is which failures are tried again and how often, never how long the
  // waiting takes. Production never passes this.
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
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
    response = await attempt(
      url,
      request,
      {
        headers: { "User-Agent": "SignalForge/0.1", ...conditional, ...headers },
        redirect: "manual",
        ...(send ? { method: send.method, body: send.body } : {}),
      },
      retryDelaysMs,
    );
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
  // AWS WAF answers a challenged client with a CAPTCHA page under an unrelated status code, so
  // the status alone reads as a broken endpoint. Naming it correctly matters: the answer to being
  // challenged is to ask less often, never to look like something else.
  if (response.headers.get("x-amzn-waf-action") || response.headers.get("cf-mitigated"))
    throw new Error("Source challenged by bot protection");
  if (!response.ok)
    throw new SourceHttpError(
      `Source returned HTTP ${response.status}`,
      response.status === 429 ? retryAt(response.headers) : null,
      response.status,
    );
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
