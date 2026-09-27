/**
 * A tool build, and whether it shipped anything.
 *
 * Claude Code and Codex ship most days, and a build that only fixes what the last one broke is news
 * to nobody: a reader who uses the tool updates anyway. The version is how a build is recognised and
 * the opening of its summary is how it is read.
 */
import { recordFor } from "./record.js";
import type { Event } from "./types.js";

/**
 * A tool build that only fixes things.
 *
 * Claude Code 2.1.276 reached the public channel on 2026-09-18 to say one proxy regression from
 * 2.1.275 was fixed; 2.1.270 and 2.1.272 ("Bug fixes and reliability improvements") had done the
 * same in the week before. A reader who uses the tool updates anyway; one who does not learns nothing.
 */
const ADDS =
  /\b(added|adds|new (?:features?|commands?|models?|settings?|options?|flags?|tools?)|introduc\w*|now (?:supports?|available)|launch\w*)\b/i;
const FIXES = /^[\s#]*(fixed|fixes|bug fixes)\b/i;
const VERSION = /\b\d+\.\d+\.\d+\b/;

/**
 * Codex 0.155.1 reached the public channel twice on 2026-09-18, from its GitHub release and from the
 * Codex changelog, to say one default was restored. The release carries its version as a tag and
 * the changelog only in its title, the summary opens with a Markdown heading, and the one fix begins
 * "New local TUI sessions" -- a bare "new" is an adjective as often as it is a feature.
 */
export function isFixesOnlyRelease(event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "news" && event.stream !== "github")) return false;
  const body = recordFor(event);
  if (!body || (!body.version && !body.tag && !VERSION.test(String(body.name ?? "")))) return false;
  const summary = String(body.summary ?? body.description ?? "");
  return FIXES.test(summary) && !ADDS.test(summary);
}
