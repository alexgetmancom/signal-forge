import type { Fetch } from "../http-client.js";

/**
 * The version a published package currently names, on the first channel it publishes to.
 *
 * Separate from the readers that download the tarball because it is the cheap half of what they do.
 * A bundle reader answers two questions -- has the package moved, and what does the new build name
 * -- and the first is a few hundred bytes of JSON while the second is a hundred megabytes. They
 * shared one interval, so the hundred megabytes set how often the few hundred bytes were asked:
 * Claude Code 2.1.284 was published at 17:11 on 2026-09-28 carrying `claude-sonnet-5-5`, and this
 * service would not have looked until 17:30 because looking meant downloading.
 *
 * The channels are given in the order the package uses them: Claude Code ships to `next` before
 * `latest`, and `next` is the whole point of reading it at all.
 */
export async function publishedVersion(
  pkg: string,
  channels: readonly string[],
  request: Fetch = fetch,
): Promise<string | null> {
  const response = await request(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`);
  const tags = (await response.json()) as Record<string, string>;
  for (const channel of channels) if (tags[channel]) return tags[channel];
  return null;
}
