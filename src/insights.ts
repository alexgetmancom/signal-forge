import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { signalClass } from "./events/signals.js";
import type { Event } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { type Judgement, judgeEvents, judgementOf } from "./jev.js";
import { summarizeForRecap } from "./summary.js";

/**
 * The morning recaps' reading, done ahead of them: Jev decides what is worth a line, DeepSeek
 * writes the line, and the recap only looks both up. Nothing here reaches a channel by itself.
 */

/** Commits a morning is told about, at most, however busy the repository was. */
const COMMIT_LINES = 3;
const COMMIT_WINDOW_MS = 26 * 3_600_000;

/**
 * A commit worth a line: one Jev reads as a model or a feature an expert would clearly want to hear
 * about, or one that names something unreleased. "Add a feature flag for asynchronous user
 * messages" scores 1.4 and is a feature; a refactor of the prompt crate scores below 1.
 */
export function isNotableCommit(judgement: Judgement | null): boolean {
  if (!judgement) return false;
  if (judgement.codename >= 0.6) return true;
  return ["new_model", "feature", "model_update"].includes(judgement.kind) && judgement.worth >= 1.6;
}

/**
 * A front-page story worth a line though no pattern placed it: about a model, a product or a risk,
 * and something an expert would clearly want. Opinion pieces and conference talks score low.
 */
export function isNewsworthyStory(judgement: Judgement | null): boolean {
  if (!judgement) return false;
  return (
    ["new_model", "model_update", "feature", "safety", "research"].includes(judgement.kind) && judgement.worth >= 2
  );
}

const COMMIT_GUIDANCE =
  "This is one commit to an AI coding tool's public repository. In at most 20 words, say what it adds or prepares that a user or an AI-model watcher would care about: a new model, a feature flag, a new tool or setting. Never claim it has shipped. If it is only refactoring, tests or fixes, reply UNCLEAR.";
const FINDING_GUIDANCE =
  "This is a safety or research post about AI. In at most 25 words, say what was found or shown and, if the text says, how serious or widespread it is. No opinions of your own.";

/** The commits of the last day worth a line, best first. */
export function notableCommits(db: Database, from: string, to: string): { event: Event; judgement: Judgement }[] {
  return db
    .query<Event, [string, string]>(
      "SELECT * FROM events WHERE source LIKE 'github:%:commits' AND kind='new' AND detected_at>=? AND detected_at<? ORDER BY id",
    )
    .all(from, to)
    .map((event) => ({ event, judgement: judgementOf(db, event.id) }))
    .filter((entry): entry is { event: Event; judgement: Judgement } => isNotableCommit(entry.judgement))
    .sort((one, other) => other.judgement.worth - one.judgement.worth)
    .slice(0, COMMIT_LINES);
}

async function noteCommits(db: Database, config: AppConfig, request: Fetch, now: Date): Promise<number> {
  const since = new Date(now.getTime() - COMMIT_WINDOW_MS).toISOString();
  let written = 0;
  for (const { event } of notableCommits(db, since, now.toISOString()))
    if (await summarizeForRecap(db, config, event, COMMIT_GUIDANCE, request, now)) written++;
  return written;
}

/** Safety and research posts from the last day, and front-page stories Jev found newsworthy. */
async function noteFindings(db: Database, config: AppConfig, request: Fetch, now: Date): Promise<number> {
  const events = db
    .query<Event, [string]>(
      "SELECT * FROM events WHERE stream IN ('news','pages') AND kind='new' AND detected_at>=? ORDER BY id DESC LIMIT 200",
    )
    .all(new Date(now.getTime() - 24 * 3_600_000).toISOString());
  let written = 0;
  for (const event of events) {
    if (written >= 10) break;
    const signal = signalClass(event);
    const finding = signal === "safety" || signal === "research";
    if (!finding) continue;
    if (await summarizeForRecap(db, config, event, FINDING_GUIDANCE, request, now)) written++;
  }
  return written;
}

/** One pass: judge what is new, then write the lines the next recaps will carry. */
export async function prepareInsights(db: Database, config: AppConfig, request: Fetch = fetch, now = new Date()) {
  const judged = await judgeEvents(db, config, request, now);
  // Judged first, so the commits worth a line are known before DeepSeek is asked about them.
  const commits = await noteCommits(db, config, request, now);
  const findings = await noteFindings(db, config, request, now);
  return { judged, commits, findings };
}
