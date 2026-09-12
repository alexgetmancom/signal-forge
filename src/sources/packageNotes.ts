import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Event, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * What a version bump actually contained.
 *
 * `npm:@openai/codex` was the third noisiest source here and every message it produced said
 * "0.51.2 → 0.51.3" and nothing else. The information a reader wants is one request away: the same
 * release on GitHub says "GPT-6-Astra is now available in the model picker", which is a model
 * sighting hiding inside a package bump.
 *
 * Tag spellings differ between projects — `v2.1.269` here, `rust-v0.154.0` there — so the version
 * is matched inside the tag rather than assumed to be the tag.
 */
const PACKAGE_REPOSITORIES: Record<string, string> = {
  "npm:@openai/codex": "openai/codex",
  "npm:@anthropic-ai/claude-code": "anthropics/claude-code",
  "npm:@google/gemini-cli": "google-gemini/gemini-cli",
  "npm:@qwen-code/qwen-code": "QwenLM/qwen-code",
  "pypi:openai": "openai/openai-python",
  "pypi:anthropic": "anthropics/anthropic-sdk-python",
  "pypi:mistralai": "mistralai/client-python",
};

const releases = z.array(
  z.object({
    tag_name: z.string().min(1),
    body: z.string().nullish(),
    draft: z.boolean().nullish(),
    published_at: z.string().nullish(),
  }),
);

const MAX_NOTES_CHARS = 6000;

function version(event: Event): string | null {
  const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const value = record?.version;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The release notes for the version this event moved to, or null when there is nothing to add. */
export async function packageReleaseNotes(
  event: Event,
  config: AppConfig,
  request: Fetch = fetch,
): Promise<string | null> {
  const repository = PACKAGE_REPOSITORIES[event.source];
  const released = version(event);
  if (!repository || !released) return null;
  const payload = await fetchText(
    `https://api.github.com/repos/${repository}/releases?per_page=30`,
    {
      accept: "application/vnd.github+json",
      ...(config.GITHUB_TOKEN ? { Authorization: `Bearer ${config.GITHUB_TOKEN}` } : {}),
    },
    request,
  );
  const published = releases.parse(JSON.parse(payload)).filter((release) => !release.draft);
  const match = published.find((release) => release.tag_name.includes(released));
  if (!match) return null;
  const body = match.body?.trim();
  return body ? `RELEASE ${match.tag_name}\n\n${body}`.slice(0, MAX_NOTES_CHARS) : null;
}
