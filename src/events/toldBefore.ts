/**
 * What a destination has already been told, and what that makes of the next event.
 *
 * Every function here answers one question with one shape: given this destination's delivery
 * history, is this event news to it? These rules are the reason a reader is not told the same
 * release four times by four routes, and they live together because they share the one dangerous
 * property -- each reads `deliveries` as of a moment, and `asOf` is how a replay asks the question
 * as it stood rather than as it stands. Moved out of batching.ts unchanged.
 */

import type { Database } from "bun:sqlite";
import { CONFIDENCE_LEVELS } from "./confidence.js";
import { isMakersAnnouncement, isStealthLaunch, stealthSubject } from "./signals.js";
import { sourceFamily } from "./sourceFamily.js";
import type { Event, RecordData } from "./types.js";
import { displayName } from "./variants.js";
import { subjectKey } from "./witness.js";
import { pageModel } from "./worth.js";

const DUPLICATE_STORY_WINDOW_MS = 6 * 3_600_000;

/**
 * The message this destination already used to tell the story these events belong to.
 *
 * The point is the payoff: a codename sighted on an arena means little until the day it resolves,
 * and a reveal that hangs off the original sighting shows the reader the whole arc in one place.
 * Only a message that was actually sent can be referenced, and only the earliest one, so the thread
 * grows from the first word rather than from the last.
 */
export function firstTelling(
  db: Database,
  events: Event[],
  storyIds: Map<number, number>,
  destinationId: string,
): string | null {
  const stories = [...new Set(events.map((event) => storyIds.get(event.id)).filter((id) => id !== undefined))];
  // The same record seen again is the other continuation, and the one the arena renames travel on:
  // `spicy-mayo` becoming `Gemini 4 Ultra` is a new subject and so a new story, while the entry it
  // was observed in never changed.
  const subjects = [...new Set(events.map((event) => `${event.source}\u0000${event.entity_id}`))];
  if (stories.length > 1 || subjects.length !== 1) return null;
  const [source, entityId] = (subjects[0] as string).split("\u0000");
  const carried = new Set(events.map((event) => event.id));
  const told = db
    .query<{ external_id: string; event_id: number }, (string | number)[]>(
      `SELECT d.external_id,de.event_id FROM delivery_events de
       JOIN deliveries d ON d.id=de.delivery_id
       JOIN events e ON e.id=de.event_id
       LEFT JOIN story_events se ON se.event_id=e.id
       WHERE d.destination_id=? AND d.status='sent' AND d.external_id IS NOT NULL
         AND ((e.source=? AND e.entity_id=?) ${stories.length ? "OR se.story_id=?" : ""})
       ORDER BY d.id`,
    )
    .all(...[destinationId, source as string, entityId as string, ...(stories.length ? [stories[0] as number] : [])]);
  return told.find((row) => !carried.has(row.event_id))?.external_id ?? null;
}

/** How long one GitHub release stays the same news for one destination. */
const RELEASE_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * The GitHub release a record stands for, whichever page carried it. OpenAI's Codex changelog links
 * each entry as `#github-release-<id>` while the repository's releases feed keys the same release by
 * `<id>`, so 0.155.1 reached #signals twice on 2026-09-18.
 */
export function releaseKey(event: Event): string | null {
  // One link per model. Grok 4.7 was announced on 2026-09-21 by xAI's release notes and by two of
  // its own pages within seventy minutes of the catalogue card; a reader needs the first of them.
  const announcement = announcementModel(event);
  if (announcement) return announcement;
  // A changelog entry that links a GitHub release is that release, whatever class the entry was
  // given. The link is identity, not judgement: once a build named for the command line stopped
  // being a release, the same build started reaching the wire twice.
  const linked = /#github-release-(\d+)$/.exec(event.entity_id);
  if (linked) return linked[1] as string;
  if (event.signal !== "release") return null;
  if (/^github:[^:]+:releases$/.test(event.source) && /^\d+$/.test(event.entity_id)) return event.entity_id;
  return null;
}

/**
 * The model a maker's own announcement is about, for an event that is one: its post's title, or the
 * slug of the page it published. Null when the event is not an announcement of the maker's own.
 */
export function announcementModel(event: Event): string | null {
  // One stealth model, however many venues list it in the same hour, and under whichever name:
  // OpenCode called it `space-bunny-free` and OpenRouter `stealth/space-bunny-alpha`.
  if (isStealthLaunch(event)) return `stealth:${stealthSubject(event)}`;
  const isPage = event.signal === "release" && (event.stream === "pages" || event.source.endsWith("-sitemap"));
  if (!isPage && !isMakersAnnouncement(event)) return null;
  const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const slug = isPage
    ? (event.entity_id.split("?")[0]?.replace(/\/+$/, "").split("/").at(-1) ?? "")
    : // A post is titled the way a post is: the model is what is left once the verb is taken off.
      String(record?.name ?? event.entity_id).replace(/^(?:introducing|announcing|meet|now available:?)\s+/i, "");
  const key = subjectKey(displayName(slug));
  return key ? `announce:${key}` : null;
}

/**
 * A cutoff for replay: count only what had already been detected when the event under judgement
 * was. Undefined in the delivery path, where "already" means now and the question is being asked
 * for the first time.
 */
export type AsOf = string | undefined;

export function releaseTold(
  db: Database,
  key: string,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): boolean {
  const since = new Date(now - RELEASE_WINDOW_MS).toISOString();
  return Boolean(
    db
      .query(
        `SELECT 1 FROM batch_events be
         JOIN events e ON e.id=be.event_id
         JOIN deliveries d ON d.batch_id=be.batch_id
         WHERE be.batch_id<>? AND d.destination_id=? AND e.detected_at>=? ${asOf ? "AND e.detected_at<?" : ""}
           AND ((e.source LIKE 'github:%:releases' AND e.entity_id=?) OR e.entity_id LIKE ?)
           AND d.status IN ('pending','sending','sent','ambiguous','verification_required')
         LIMIT 1`,
      )
      .get(...[batchId, destinationId, since, ...(asOf ? [asOf] : []), key, `%#github-release-${key}`]),
  );
}

/** How long one model's announcement stays the same link for one destination. */
const ANNOUNCEMENT_WINDOW_MS = 3 * 24 * 3_600_000;

/**
 * Whether this destination already carries a maker's announcement of the same model.
 *
 * The GitHub release guard next to this one matches on a release id, which an announcement has no
 * equivalent of: xAI's release notes, its docs page and its model page each call Grok 4.7 something
 * different. The model the announcement is about is what they share, so that is what is compared.
 */
/** A maker's own announcement of one model, as this database happens to have recorded it. */
export type Announcement = { at: string; source: string };

/**
 * The earliest announcement recorded here for each model, by the key an announcement is keyed on.
 *
 * Read once per batch, because a card that says a model is unannounced has to be able to be wrong
 * about it. What this cannot do is prove the negative: collection here began on 2026-09-08, and
 * OpenAI had announced GPT-5.6 Cyber on 11 August, so the docs page sighted on 25 September found
 * no announcement in this table and the card called a model with a press release "not announced
 * yet". An absent row means this service never saw one, which is why the sentence built from this
 * map only ever speaks when there is a row.
 */
export function announcementsBySubject(db: Database): Map<string, Announcement> {
  const found = new Map<string, Announcement>();
  for (const row of db
    .query<Event, []>("SELECT * FROM events WHERE stream IN ('news','pages','changelog') AND kind='new'")
    .all()) {
    const model = announcementModel(row);
    if (!model) continue;
    const seen = found.get(model);
    if (!seen || row.detected_at < seen.at) found.set(model, { at: row.detected_at, source: row.source });
  }
  return found;
}

/** What this database knows about the maker having announced the model an event is about. */
export function announcementOf(event: Event, announcements: ReadonlyMap<string, Announcement>): Announcement | null {
  const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const names = [record?.name, record?.model, event.entity_id].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  for (const name of names) {
    const key = subjectKey(displayName(name.split(":")[0] ?? name));
    const found = key ? announcements.get(`announce:${key}`) : undefined;
    // An announcement detected after the sighting is the reveal, not a thing the sighting missed.
    if (found && found.at < event.detected_at) return found;
  }
  return null;
}

export function announcementTold(
  db: Database,
  model: string,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): boolean {
  const since = new Date(now - ANNOUNCEMENT_WINDOW_MS).toISOString();
  return db
    .query<Event, (string | number)[]>(
      `SELECT e.* FROM batch_events be
       JOIN events e ON e.id=be.event_id
       JOIN deliveries d ON d.batch_id=be.batch_id
       WHERE be.batch_id<>? AND d.destination_id=? AND e.detected_at>=? ${asOf ? "AND e.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[batchId, destinationId, since, ...(asOf ? [asOf] : [])])
    .some((row) => announcementModel(row) === model);
}

/**
 * A sighting of something its maker had already announced, to anyone.
 *
 * xAI's release notes put Grok Voice Transcribe 2.0 on the public channel at 06:26 on 2026-09-18;
 * the news page about it appeared in xAI's sitemap twelve hours later and reached the scouts as a
 * sighting. The repeat check is per destination and the scouts had not been told, but a sighting is
 * the earliest word on something, and after the maker's announcement it is the latest. Both events
 * were in one story, so the story says it.
 */
export function announcedBeforeSighted(
  db: Database,
  event: Event,
  storyId: number | undefined,
  batchId: number,
): boolean {
  if (storyId === undefined || event.kind !== "new") return false;
  return Boolean(
    db
      .query(
        `SELECT 1 FROM story_events previous
         JOIN events earlier ON earlier.id=previous.event_id
         JOIN batch_events be ON be.event_id=earlier.id
         JOIN deliveries d ON d.batch_id=be.batch_id
         WHERE previous.story_id=? AND previous.event_id<>? AND be.batch_id<>? AND earlier.detected_at<=?
           AND be.signal IN ('launch','release','feature')
           AND d.status IN ('sent','sending','ambiguous','verification_required')
         LIMIT 1`,
      )
      .get(storyId, event.id, batchId, event.detected_at),
  );
}

const DEBUT_WINDOW_MS = 24 * 3_600_000;

export function repeatsDeliveredStory(
  db: Database,
  event: Event,
  destinationId: string,
  storyId: number | undefined,
  batchId: number,
  asOf: AsOf = undefined,
): boolean {
  if (storyId === undefined || event.kind !== "new") return false;
  const candidates = db
    .query<
      { source: string; stream: string; detected_at: string; confidence: string; signal: string },
      (number | string)[]
    >(
      `SELECT DISTINCT earlier.source,earlier.stream,earlier.detected_at,earlier.confidence,be.signal
       FROM story_events se
       JOIN story_events previous ON previous.story_id=se.story_id AND previous.event_id<>se.event_id
       JOIN events earlier ON earlier.id=previous.event_id
       JOIN batch_events be ON be.event_id=earlier.id
       JOIN deliveries d ON d.batch_id=be.batch_id
       WHERE se.event_id=? AND be.batch_id<>? AND d.destination_id=? ${asOf ? "AND earlier.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[event.id, batchId, destinationId, ...(asOf ? [asOf] : [])]);
  const detectedAt = Date.parse(event.detected_at);
  // A debut is news about a model the reader was already told arrived: the launch card said it
  // exists, the debut says how good it is. Only another debut of the same model repeats it, from
  // whichever board, so a model entering three boards in a day is one card.
  if (event.signal === "debut")
    return candidates.some(
      (candidate) =>
        candidate.signal === "debut" && Math.abs(detectedAt - Date.parse(candidate.detected_at)) <= DEBUT_WINDOW_MS,
    );
  return candidates.some((candidate) => {
    const earlierAt = Date.parse(candidate.detected_at);
    return (
      Number.isFinite(earlierAt) &&
      Number.isFinite(detectedAt) &&
      Math.abs(detectedAt - earlierAt) <= DUPLICATE_STORY_WINDOW_MS &&
      sourceFamily(candidate.source, candidate.stream) !== sourceFamily(event.source, event.stream) &&
      CONFIDENCE_LEVELS.indexOf(candidate.confidence as NonNullable<Event["confidence"]>) >=
        CONFIDENCE_LEVELS.indexOf(event.confidence ?? "observed")
    );
  });
}

/** How long a model named by a vendor's pages stays the same piece of news for one destination. */
const PAGE_MODEL_WINDOW_MS = 24 * 3_600_000;

/** The models this destination was already told a vendor's pages are naming. */
export function pageModelsTold(
  db: Database,
  destinationId: string,
  batchId: number,
  now: number,
  asOf: AsOf = undefined,
): Set<string> {
  const rows = db
    .query<Event, (string | number)[]>(
      `SELECT DISTINCT e.* FROM delivery_events de
       JOIN deliveries d ON d.id=de.delivery_id
       JOIN events e ON e.id=de.event_id
       WHERE d.destination_id=? AND d.batch_id<>? AND e.stream='pages' AND e.kind='new' AND e.detected_at>=?
         ${asOf ? "AND e.detected_at<?" : ""}
         AND d.status IN ('pending','sending','sent','ambiguous','verification_required')`,
    )
    .all(...[destinationId, batchId, new Date(now - PAGE_MODEL_WINDOW_MS).toISOString(), ...(asOf ? [asOf] : [])]);
  return new Set(rows.map(pageModel).filter((model): model is string => model !== null));
}
