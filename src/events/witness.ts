import type { Database } from "bun:sqlite";
import { isMirror } from "./mirrors.js";
import { modelSubject, releasedModelSubject } from "./variants.js";

/**
 * Models something other than a price list knows about.
 *
 * A catalogue reprices hundreds of rows and most of them are models nobody here has heard of. In
 * the week of 8 September, Qwen3 14B -- a small dense model from April 2025 -- moved 3.8 times on
 * OpenRouter because the cheapest provider serving it changed, and won the recap's price line from
 * DeepSeek V3.1 actually getting 55% cheaper. Six days later it moved back to the exact figure it
 * started from.
 *
 * The floor is evidence, not taste: a benchmark ranks it, an arena serves it, or its own maker
 * lists it in their API. A row that exists only in a reseller's price list has one collector's word
 * that it matters, and that is not enough to spend one of three lines a week on.
 */

/** A subject reduced until two spellings of one model meet: `solar-pro4-20260805` and `Upstage: Solar Pro 4`. */
export function subjectKey(name: string): string {
  return modelSubject(name)
    .replace(/\s+\d{8}$/, "")
    .replace(/\s+/g, "");
}

/**
 * A stored record body as an object, or null for one that is not.
 *
 * The service writes every body itself, so a row that does not parse is damage rather than input.
 * Each reader here treats the row as absent -- a model it cannot read is a model it does not
 * witness -- instead of failing a whole report over one row.
 */
function parseRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function witnessedSubjects(db: Database): Set<string> {
  const witnessed = new Set<string>();
  // Where a model is known by something other than the catalogue selling it: a benchmark ranks it,
  // an arena serves it, or its own maker lists it.
  const rows = db
    .query<{ body: string }, []>("SELECT body FROM records WHERE stream IN ('leaderboards','arena','api-models')")
    .all();
  for (const row of rows) {
    const record = parseRecord(row.body);
    if (!record) continue;
    for (const value of [record.name, record.model, record.modelKey, record.id])
      if (typeof value === "string" && value.trim()) witnessed.add(subjectKey(value));
  }
  return witnessed;
}

/** Which catalogues and registries carry each model, keyed like `subjectKey`. */
export function listingsBySubject(db: Database): Map<string, Set<string>> {
  const listings = new Map<string, Set<string>>();
  const rows = db
    .query<{ source: string; id: string; body: string }, []>(
      "SELECT source,id,body FROM records WHERE stream IN ('api-models','openrouter','weights') AND source NOT LIKE 'discovery:%'",
    )
    .all();
  for (const row of rows) {
    if (isMirror(row.source)) continue;
    const name = parseRecord(row.body)?.name;
    for (const value of new Set([row.id, typeof name === "string" ? name : row.id])) {
      const key = subjectKey(value);
      const sources = listings.get(key) ?? new Set<string>();
      sources.add(row.source);
      listings.set(key, sources);
    }
  }
  return listings;
}

/**
 * Every model any catalogue already carries, keyed with its release channel stripped off.
 *
 * This answers one question and no other: is the model behind this name already out? A mirror
 * counts here, unlike in `listingsBySubject`, because a card built on this never names the venue --
 * it only stays quiet.
 */
export function releasedSubjects(db: Database): Set<string> {
  const released = new Set<string>();
  const rows = db
    .query<{ id: string; body: string }, []>(
      "SELECT id,body FROM records WHERE stream IN ('api-models','openrouter','weights') AND source NOT LIKE 'discovery:%'",
    )
    .all();
  for (const row of rows) {
    const name = parseRecord(row.body)?.name;
    for (const value of new Set([row.id, typeof name === "string" ? name : row.id]))
      released.add(releasedModelSubject(value));
  }
  return released;
}

/**
 * When each model subject was first seen here, and by which source.
 *
 * A story would answer this, but a story is keyed on the name as written, and a reseller writes
 * the maker into it: "Cohere: Command A+" and "Command A+" are two stories about one model. The
 * subject key is what already survives that difference everywhere else in this file.
 *
 * It survives less than it looks: a tier in the name is part of the key, so "Muse Glimmer (High)"
 * keys as `museglimmerhigh` and the Vertex row `meta/muse-glimmer` as `museglimmer`. Muse Glimmer
 * reached the scouts on 2026-10-12 as a sighting, 34 days after this deployment first saw it,
 * because of that one word. `firstSightingByStory` is the other half and the two are read together.
 */
export function firstSightingBySubject(db: Database): Map<string, { at: number; source: string }> {
  const first = new Map<string, { at: number; source: string }>();
  const rows = db
    .query<{ source: string; entity_id: string; name: string | null; at: string }, []>(
      `SELECT source,entity_id,COALESCE(json_extract(after_json,'$.name'),entity_id) AS name,MIN(detected_at) AS at
       FROM events WHERE kind='new' GROUP BY source,entity_id`,
    )
    .all();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    for (const value of new Set([row.entity_id, row.name ?? row.entity_id])) {
      const key = subjectKey(value);
      const seen = first.get(key);
      if (!seen || at < seen.at) first.set(key, { at, source: row.source });
    }
  }
  return first;
}

/**
 * When the subject of each of these events was first seen here, read through the story it was
 * correlated into, and by which source.
 *
 * The correlation already decided that two spellings are one model, which is exactly what a subject
 * key has to guess: `meta/muse-glimmer` is in the story a month of Muse Glimmer sightings built.
 * Asked of the batch's events rather than of the whole table, because the delivery path pays for it.
 *
 * It answers nothing where correlation itself missed -- `qwen-3.8` from a price list became its own
 * story beside `Qwen3.8-Max` -- so this is read beside `firstSightingBySubject`, never instead.
 */
export function firstSightingByStory(
  db: Database,
  eventIds: readonly number[],
): Map<number, { at: number; source: string }> {
  const first = new Map<number, { at: number; source: string }>();
  if (!eventIds.length) return first;
  const places = eventIds.map(() => "?").join(",");
  const rows = db
    .query<{ event_id: number; at: string; source: string }, number[]>(
      `SELECT se.event_id, oldest.detected_at AS at, oldest.source AS source
         FROM story_events se
         JOIN (SELECT se2.story_id, e2.detected_at, e2.source,
                      ROW_NUMBER() OVER (PARTITION BY se2.story_id ORDER BY e2.detected_at, e2.id) AS place
                 FROM story_events se2 JOIN events e2 ON e2.id = se2.event_id) AS oldest
           ON oldest.story_id = se.story_id AND oldest.place = 1
        WHERE se.event_id IN (${places})`,
    )
    .all(...eventIds);
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    const seen = first.get(row.event_id);
    if (!seen || at < seen.at) first.set(row.event_id, { at, source: row.source });
  }
  return first;
}

/**
 * When each model name was first seen here, as the stories say it, by the key a page's address uses.
 *
 * The events are not the whole history: this deployment started from catalogues it read whole, and
 * a first collection stores records without emitting a difference for any of them. Gemini 3.7 Flash
 * has been in `records` and in a story since 2026-09-08 and its earliest *event* is 2026-09-27, so
 * a page about it looked ten days old to a question asked of events alone and five weeks old to a
 * reader.
 */
export function firstStoryByName(db: Database): Map<string, number> {
  const first = new Map<string, number>();
  for (const row of db
    .query<{ title: string; normalized_subject: string; at: string }, []>(
      "SELECT title,normalized_subject,first_seen_at AS at FROM stories",
    )
    .all()) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    for (const value of new Set([row.title, row.normalized_subject])) {
      const key = subjectKey(value);
      if (!key) continue;
      const seen = first.get(key);
      if (seen === undefined || at < seen) first.set(key, at);
    }
  }
  return first;
}

/**
 * How heavily a model is used, as a place in the ranking, for the models that appear on one.
 *
 * Three price lines a week is a budget, and spending one on a model nobody runs is how DeepSeek V4
 * Flash 0731 -- fourth by tokens on the very catalogue that repriced it -- went unmentioned as it
 * got three times cheaper. A model that is not ranked is not disqualified; it simply goes last.
 */
export function usageRanks(db: Database): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const row of db.query<{ body: string }, []>("SELECT body FROM records WHERE source='openrouter-usage'").all()) {
    const record = parseRecord(row.body);
    if (!record) continue;
    const place = Number(record.rank);
    if (typeof record.id === "string" && Number.isFinite(place)) {
      const key = subjectKey(record.id);
      if (!ranks.has(key) || place < (ranks.get(key) ?? place)) ranks.set(key, place);
    }
  }
  return ranks;
}

/**
 * The other entries a roster already carries under the same name.
 *
 * Gemini 3.8 Flash was released on 2026-09-02 and sat on the arena as `gemini-3.8-flash-low` and
 * `-medium` behind Google's Vertex provider. On 2026-09-17 a third entry arrived as bare
 * `gemini-3.8-flash`, text-only and with no provider. The card called it an unidentified model; what a
 * reader needed was the difference from the entries already there. A sibling is a row of the same
 * source and maker whose name is this name, or this name with a suffix.
 */
export function rosterSiblings(
  db: Database,
  source: string,
  id: string,
  name: string,
  maker: unknown,
): Record<string, unknown>[] {
  const key = subjectKey(name);
  if (!key) return [];
  return db
    .query<{ id: string; body: string }, [string, string]>("SELECT id,body FROM records WHERE source=? AND id<>?")
    .all(source, id)
    .flatMap((row) => {
      const record = parseRecord(row.body);
      return record ? [record] : [];
    })
    .filter(
      (record) =>
        typeof record.name === "string" &&
        subjectKey(record.name).startsWith(key) &&
        String(record.maker ?? "").toLowerCase() === String(maker ?? "").toLowerCase(),
    )
    .sort((one, other) => String(one.name).localeCompare(String(other.name)));
}
