import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";
import { leadTime } from "./leadTime.js";

/**
 * Which collectors earn their place, read once a month.
 *
 * ModelScope ran for a week before anyone asked what it had done, and the answer -- two first
 * sightings, no lead over any source, nothing delivered -- was found by hand. A source earns its
 * place in one of three ways: it sees something before another source does, a card from it reaches
 * a reader, or the scouts vouch for one of its cards. A source that did none of the three over the
 * period is named, with the numbers, so removing it is a decision instead of an investigation.
 *
 * Reaching a reader is a fact about routing, not about the source: a class no destination takes
 * and a source held in shadow deliver nothing however good they are. So the value of a source is
 * also read without routing. An event is corroborated when another source put an event into the
 * same story -- somebody else saw the same thing -- and a corroborated event that never reached a
 * reader is held-back value: the source is good and the routing has not caught up with it. An
 * event nobody else ever saw is not proof of noise, since a leading source is alone at first, which
 * is why the rate is reported beside the lead rather than turned into a verdict of its own.
 */
export type SourceVerdict = {
  source: string;
  mode: string;
  ledOthers: number;
  firstSightings: number;
  delivered: number;
  scoutVotes: number;
  /** Events the source recorded in the period. */
  events: number;
  /** Of those, how many share a story with another source's event. */
  corroborated: number;
  /** corroborated / events, rounded to two places; null with no events. */
  corroborationRate: number | null;
  /** Corroborated events that never reached a reader: value the routing is not carrying. */
  heldBack: number;
  verdict: "earning" | "held_back" | "no_measurable_value";
};

export function sourceVerdicts(
  db: Database,
  config: AppConfig,
  days = 30,
  now = Date.now(),
): {
  since: string;
  sources: SourceVerdict[];
  notYetJudged: { source: string; collectingSince: string | null }[];
  /** The same numbers for sources too young to judge, so a trial can be watched while it runs. */
  preliminary: SourceVerdict[];
} {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const leads = new Map(leadTime(db, days, now).sources.map((row) => [row.source, row]));
  const delivered = new Map(
    db
      .query<{ source: string; n: number }, [string]>(
        `SELECT e.source, COUNT(DISTINCT e.id) n FROM delivery_events de
         JOIN deliveries d ON d.id=de.delivery_id JOIN events e ON e.id=de.event_id
         WHERE d.status='sent' AND e.detected_at>=? GROUP BY e.source`,
      )
      .all(since)
      .map((row) => [row.source, row.n]),
  );
  const votes = new Map(
    db
      .query<{ source: string; n: number }, [string]>(
        `SELECT e.source, SUM(r.votes) n FROM scout_reactions r
         JOIN delivery_events de ON de.delivery_id=r.delivery_id JOIN events e ON e.id=de.event_id
         WHERE e.detected_at>=? GROUP BY e.source`,
      )
      .all(since)
      .map((row) => [row.source, row.n]),
  );
  const witnessed = new Map(
    db
      .query<{ source: string; events: number; corroborated: number; held: number }, [string]>(
        `SELECT e.source,
                COUNT(*) events,
                SUM(EXISTS (
                  SELECT 1 FROM story_events other JOIN events o ON o.id=other.event_id
                  WHERE other.story_id=se.story_id AND o.source<>e.source)) corroborated,
                SUM(EXISTS (
                  SELECT 1 FROM story_events other JOIN events o ON o.id=other.event_id
                  WHERE other.story_id=se.story_id AND o.source<>e.source)
                  AND NOT EXISTS (
                  SELECT 1 FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
                  WHERE de.event_id=e.id AND d.status='sent')) held
         FROM events e LEFT JOIN story_events se ON se.event_id=e.id
         WHERE e.detected_at>=? GROUP BY e.source`,
      )
      .all(since)
      .map((row) => [row.source, row]),
  );
  // A source that has not been collecting for the whole period has not had the chance to earn it.
  const collectingSince = new Map(
    db
      .query<{ source: string; first: string }, []>(
        "SELECT source, MIN(collected_at) AS first FROM source_collection_metrics WHERE success=1 GROUP BY source",
      )
      .all()
      .map((row) => [row.source, row.first]),
  );
  const enabled = buildSourceRegistry(db, config).filter((definition) => definition.enabled);
  const judged = (id: string) => (collectingSince.get(id) ?? "9999") <= since;
  // Named rather than dropped: on production the metrics began on 2026-09-09, so for its first
  // month every source was too young and the report answered an empty list with no reason.
  const notYetJudged = enabled
    .filter((definition) => !judged(definition.id))
    .map((definition) => ({ source: definition.id, collectingSince: collectingSince.get(definition.id) ?? null }))
    .sort((left, right) => left.source.localeCompare(right.source));
  const verdictFor = (definition: (typeof enabled)[number]): SourceVerdict => {
    const lead = leads.get(definition.id);
    const seen = witnessed.get(definition.id);
    const events = seen?.events ?? 0;
    const corroborated = seen?.corroborated ?? 0;
    const row = {
      source: definition.id,
      mode: definition.mode,
      ledOthers: lead?.ledOthers ?? 0,
      firstSightings: lead?.firstSightings ?? 0,
      delivered: delivered.get(definition.id) ?? 0,
      scoutVotes: votes.get(definition.id) ?? 0,
      events,
      corroborated,
      corroborationRate: events ? Math.round((corroborated / events) * 100) / 100 : null,
      heldBack: seen?.held ?? 0,
    };
    const earning = row.ledOthers > 0 || row.delivered > 0 || row.scoutVotes > 0;
    return {
      ...row,
      verdict: earning ? "earning" : row.heldBack > 0 ? "held_back" : "no_measurable_value",
    };
  };
  const rank: Record<SourceVerdict["verdict"], number> = { no_measurable_value: 0, held_back: 1, earning: 2 };
  const ordered = (rows: SourceVerdict[]) =>
    rows.sort((left, right) => rank[left.verdict] - rank[right.verdict] || left.source.localeCompare(right.source));
  const sources = ordered(enabled.filter((definition) => judged(definition.id)).map(verdictFor));
  const preliminary = ordered(enabled.filter((definition) => !judged(definition.id)).map(verdictFor));
  return { since, sources, notYetJudged, preliminary };
}
