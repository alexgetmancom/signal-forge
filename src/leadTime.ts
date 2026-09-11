import type { Database } from "bun:sqlite";
import { sourceLabel } from "./sources/labels.js";

/**
 * Which sources actually break news, and how far ahead of the rest.
 *
 * Every source costs a request, a row and a chance to be wrong, and the only justification for one
 * is that it sees something before the others do. That was never measured: a source that repeats
 * what four others already said looks exactly like a source that led, because both produce events.
 *
 * A story is one subject correlated across sources, so the first event in a story is the sighting
 * that led and the rest are corroboration. Counting wins per source answers, with evidence, which
 * collectors earn their place — and how long the rest took to catch up.
 */
export type LeadTimeRow = {
  source: string;
  label: string;
  /** Stories this source saw before any other source did. */
  firstSightings: number;
  /** Stories it reached at all, leading or not. */
  appearances: number;
  /** Median hours by which it beat the next source to arrive, across the stories it led. */
  medianLeadHours: number | null;
  /** Median hours it trailed the leader, across stories it did not lead. */
  medianLagHours: number | null;
};

type Sighting = { story_id: number; source: string; detected_at: string };

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round((value ?? 0) * 10) / 10;
}

export function leadTime(db: Database, days = 7): { since: string; stories: number; sources: LeadTimeRow[] } {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const sightings = db
    .query<Sighting, [string]>(
      `SELECT se.story_id, e.source, MIN(e.detected_at) AS detected_at
       FROM story_events se JOIN events e ON e.id=se.event_id
       WHERE e.detected_at >= ?
       GROUP BY se.story_id, e.source
       ORDER BY se.story_id, detected_at`,
    )
    .all(since);

  const byStory = new Map<number, Sighting[]>();
  for (const sighting of sightings) {
    const group = byStory.get(sighting.story_id) ?? [];
    group.push(sighting);
    byStory.set(sighting.story_id, group);
  }

  const leads = new Map<string, number[]>();
  const lags = new Map<string, number[]>();
  const wins = new Map<string, number>();
  const appearances = new Map<string, number>();
  const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

  for (const group of byStory.values()) {
    const [leader, runnerUp] = group;
    if (!leader) continue;
    for (const sighting of group) appearances.set(sighting.source, (appearances.get(sighting.source) ?? 0) + 1);
    wins.set(leader.source, (wins.get(leader.source) ?? 0) + 1);
    // A story only one source ever saw proves nothing about speed, so it counts as a win with no
    // measurable lead rather than an infinite one.
    if (runnerUp) {
      const lead = leads.get(leader.source) ?? [];
      lead.push(hours(leader.detected_at, runnerUp.detected_at));
      leads.set(leader.source, lead);
    }
    for (const sighting of group.slice(1)) {
      const lag = lags.get(sighting.source) ?? [];
      lag.push(hours(leader.detected_at, sighting.detected_at));
      lags.set(sighting.source, lag);
    }
  }

  const sources = [...appearances.keys()]
    .map((source) => ({
      source,
      label: sourceLabel(source),
      firstSightings: wins.get(source) ?? 0,
      appearances: appearances.get(source) ?? 0,
      medianLeadHours: median(leads.get(source) ?? []),
      medianLagHours: median(lags.get(source) ?? []),
    }))
    .sort((left, right) => right.firstSightings - left.firstSightings || right.appearances - left.appearances);

  return { since, stories: byStory.size, sources };
}
