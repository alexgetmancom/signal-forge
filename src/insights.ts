import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { signalOf } from "./events/classify.js";
import type { Event } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { type Judgement, judgeEvents, judgementOf, worthCutoff } from "./jev.js";
import { publishMonthlyAudit, publishWeeklyVotes } from "./review.js";
import { olderThanKnown } from "./sources/mentionStage.js";
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
export function isNotableCommit(judgement: Judgement | null, cutoff = COMMIT_WORTH): boolean {
  if (!judgement) return false;
  if (judgement.codename >= 0.6) return true;
  return ["new_model", "feature", "model_update"].includes(judgement.kind) && judgement.worth >= cutoff;
}

/**
 * A front-page story worth a line though no pattern placed it: about a model, a product or a risk,
 * and something an expert would clearly want. Opinion pieces and conference talks score low.
 */
export function isNewsworthyStory(judgement: Judgement | null, cutoff = STORY_WORTH): boolean {
  if (!judgement) return false;
  return (
    ["new_model", "model_update", "feature", "safety", "research"].includes(judgement.kind) && judgement.worth >= cutoff
  );
}

/**
 * The shares those numbers admitted when they were chosen, and the numbers themselves for a database
 * too young to have a distribution. Over the 1046 judgements they were calibrated against, 1.6 let
 * through the top 22% of commits and 2 the top 4.5% of stories.
 */
const COMMIT_WORTH = 1.6;
const STORY_WORTH = 2;
const COMMIT_SHARE = 0.22;
const STORY_SHARE = 0.045;

/** Today's cutoffs, read once per pass rather than per candidate. */
export function worthCutoffs(db: Database, now = new Date()): { commit: number; story: number } {
  return {
    commit: worthCutoff(db, COMMIT_SHARE, COMMIT_WORTH, now),
    story: worthCutoff(db, STORY_SHARE, STORY_WORTH, now),
  };
}

const COMMIT_GUIDANCE =
  "This is one commit to an AI coding tool's public repository. In at most 20 words, say what it adds or prepares that a user or an AI-model watcher would care about: a new model, a feature flag, a new tool or setting. Never claim it has shipped. If it is only refactoring, tests or fixes, reply UNCLEAR.";
const FINDING_GUIDANCE =
  "This is a safety or research post about AI. In at most 25 words, say what was found or shown and, if the text says, how serious or widespread it is. No opinions of your own.";

/** The commits of the last day worth a line, best first. */
/**
 * A commit whose news is a model name already superseded by a newer one of its kind. "Add gpt-5.1-mini
 * to the model list" landed in openai-openapi on 2026-09-21, with gpt-5.4-mini long on sale, and the
 * scouts read it as a sighting.
 */
function addsOnlyOlderModels(db: Database, event: Event): boolean {
  const record = event.after_json ? (JSON.parse(event.after_json) as { name?: string; summary?: string }) : {};
  const added = `${record.name ?? ""}\n${(record.summary ?? "")
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .join("\n")}`;
  const models = new Set(added.match(/\b(?:gpt|claude|gemini|grok|o\d)-[a-z0-9.-]*\d[a-z0-9.-]*/gi) ?? []);
  return models.size > 0 && [...models].every((model) => olderThanKnown(db, model.toLowerCase(), true));
}

export function notableCommits(db: Database, from: string, to: string): { event: Event; judgement: Judgement }[] {
  const cutoff = worthCutoffs(db, new Date(to)).commit;
  return db
    .query<Event, [string, string]>(
      "SELECT * FROM events WHERE source LIKE 'github:%:commits' AND kind='new' AND detected_at>=? AND detected_at<? ORDER BY id",
    )
    .all(from, to)
    .map((event) => ({ event, judgement: judgementOf(db, event.id) }))
    .filter((entry): entry is { event: Event; judgement: Judgement } => isNotableCommit(entry.judgement, cutoff))
    .filter(({ event }) => !addsOnlyOlderModels(db, event))
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
    const signal = signalOf(event);
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
  const audited = await publishMonthlyAudit(db, config, request, now.getTime());
  await publishWeeklyVotes(db, config, request, now.getTime());
  return { judged, commits, findings, audited };
}

/**
 * Jev's vote on a newsroom post, which is a vote and never a veto.
 *
 * `isAboutTheCompanyNotAModel` decides a vendor's post by two words: it speaks if its title names a
 * model this deployment knows, or opens with "introducing". That rule let an Australian youth
 * safety blueprint through for opening with "Introducing", and held back every one of the nine
 * anthropic-news posts of the week to 2026-09-23 -- none reached a reader. A calibrated reader of
 * the post itself is the thing the word rule is standing in for, so where it has one, it defers.
 *
 * It votes only on what it has read. No judgement is no vote, and the word rule stands: judging
 * runs a cycle behind collection, so an immediate card is usually decided before Jev has seen it.
 * A rescue takes the same share of the distribution the morning's stories take, and a post already
 * heading out is deferred to the recap only from the bottom tenth.
 */
const NEWSROOM_FLOOR_SHARE = 0.9;
const NEWSROOM_FLOOR = 0.5;

export function newsroomVote(db: Database, eventId: number, now = new Date()): "speaks" | "recap" | null {
  const judgement = judgementOf(db, eventId);
  if (!judgement) return null;
  if (judgement.worth >= worthCutoffs(db, now).story) return "speaks";
  return judgement.worth <= worthCutoff(db, NEWSROOM_FLOOR_SHARE, NEWSROOM_FLOOR, now) ? "recap" : null;
}

/**
 * The readers' vote on a source, which is a vote and never a veto.
 *
 * Every card's thumbs are already counted, for both channels, and until now nothing read them back.
 * They are the only signal in the system that comes from the people the newsroom is written for,
 * rather than from a rule about what they might want. A reaction arrives after its own card, so it
 * can never hold that card back; what it can say is whether this source has been worth reading
 * before. The Gemini models blog is the case it was built from: two posts in sixty days, one
 * delivered, nought in favour and three against -- the worst received card the newsroom has sent.
 *
 * It speaks only where a source has actually been voted against more than for, and only about the
 * posts a word rule was already unsure of. A release stays a release: this holds back a blog, not a
 * model. Jev outranks it, so a post he vouches for goes out however the source's last cards landed.
 *
 * The threshold is two because the counts are small and one thumb is a mood. It stays arithmetic
 * for that reason: there is not enough here to calibrate a judge on, and pretending otherwise would
 * teach the judge noise.
 */
const READERS_AGAINST = 2;
const READERS_WINDOW_DAYS = 60;

export function readersVote(db: Database, source: string, now = new Date()): "against" | null {
  const since = new Date(now.getTime() - READERS_WINDOW_DAYS * 86_400_000).toISOString();
  const tally = db
    .query<{ against: number; favour: number }, [string, string]>(
      `SELECT COALESCE(SUM(r.against),0) against, COALESCE(SUM(r.votes),0) favour
         FROM scout_reactions r
         JOIN delivery_events de ON de.delivery_id = r.delivery_id
         JOIN events e ON e.id = de.event_id
        WHERE e.source = ? AND e.detected_at >= ?`,
    )
    .get(source, since);
  if (!tally) return null;
  return tally.against >= READERS_AGAINST && tally.against > tally.favour ? "against" : null;
}
