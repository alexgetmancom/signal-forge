import type { Fetch } from "../delivery.js";

export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  request: Fetch = fetch,
  // Some catalogues only answer a POST/PUT with a filter body; the retry, redirect and size rules
  // are the same, so the verb is a parameter rather than a second copy of this function.
  send?: { method: string; body: string },
): Promise<string> {
  let response: Response | undefined;
  const origin = new URL(url).origin;
  for (let hop = 0; hop < 4; hop++) {
    response = await request(url, {
      headers: { "User-Agent": "SignalForge/0.1", ...headers },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
      ...(send ? { method: send.method, body: send.body } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
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
  return Buffer.concat(chunks).toString("utf8");
}
