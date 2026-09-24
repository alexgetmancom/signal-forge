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
 *
 * Only arrivals are corroborated. On production on 2026-09-19 every one of Moonshot's 354 `created`
 * drift events read as corroborated, and so did every rank move, because the story they sit in is
 * a real model that other sources carry. Another source seeing the same model says nothing about a
 * number that moved; another source seeing the same thing appear is the question being asked.
 */
export type SourceVerdict = {
  source: string;
  mode: string;
  /** Days this source has been collecting, which is what its verdict stands on. */
  observedDays: number | null;
  ledOthers: number;
  firstSightings: number;
  delivered: number;
  scoutVotes: number;
  /** Thumbs down the source's cards drew, which delivering more cards cannot cancel out. */
  scoutVotesAgainst: number;
  /** Events the source recorded in the period. */
  events: number;
  /** Of those, how many were arrivals that share a story with another source's event. */
  corroborated: number;
  /** Arrivals the source recorded in the period. */
  arrivals: number;
  /** corroborated / arrivals, rounded to two places; null with no arrivals. */
  corroborationRate: number | null;
  /** Corroborated events that never reached a reader: value the routing is not carrying. */
  heldBack: number;
  verdict: "earning" | "voted_down" | "held_back" | "no_measurable_value";
};

const MIN_OBSERVED_DAYS = 14;

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
  const reactions = new Map(
    db
      .query<{ source: string; n: number; against: number }, [string]>(
        `SELECT e.source, SUM(r.votes) n, SUM(r.against) against FROM scout_reactions r
         JOIN delivery_events de ON de.delivery_id=r.delivery_id JOIN events e ON e.id=de.event_id
         WHERE e.detected_at>=? GROUP BY e.source`,
      )
      .all(since)
      .map((row) => [row.source, row]),
  );
  const witnessed = new Map(
    db
      .query<{ source: string; events: number; arrivals: number; corroborated: number; held: number }, [string]>(
        `SELECT e.source,
                COUNT(*) events,
                SUM(e.kind='new') arrivals,
                SUM(e.kind='new' AND EXISTS (
                  SELECT 1 FROM story_events other JOIN events o ON o.id=other.event_id
                  WHERE other.story_id=se.story_id AND o.source<>e.source)) corroborated,
                SUM(e.kind='new' AND EXISTS (
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
  const observedDays = (id: string): number | null => {
    const first = collectingSince.get(id);
    return first ? Math.floor((now - Date.parse(first)) / 86_400_000) : null;
  };
  /**
   * Long enough to answer for itself, rather than as long as the window.
   *
   * The bar was "collecting since before the window began", and the metrics table began on
   * 2026-09-09: every one of the 115 enabled sources was too young for a thirty-day question, the
   * verdict list was empty every single time it was asked, and it would have stayed empty until
   * October. A fortnight of collection is enough evidence to say whether anything a source saw
   * ever reached a reader, and `observedDays` on every row says how much evidence that verdict
   * stands on.
   */
  const judged = (id: string) => (observedDays(id) ?? -1) >= MIN_OBSERVED_DAYS;
  // Named rather than dropped: on production the metrics began on 2026-09-09, so for its first
  // month every source was too young and the report answered an empty list with no reason.
  const notYetJudged = enabled
    .filter((definition) => !judged(definition.id))
    .map((definition) => ({ source: definition.id, collectingSince: collectingSince.get(definition.id) ?? null }))
    .sort((left, right) => left.source.localeCompare(right.source));
  const verdictFor = (definition: (typeof enabled)[number]): SourceVerdict => {
    const observed = observedDays(definition.id);
    const lead = leads.get(definition.id);
    const seen = witnessed.get(definition.id);
    const events = seen?.events ?? 0;
    const arrivals = seen?.arrivals ?? 0;
    const corroborated = seen?.corroborated ?? 0;
    const row = {
      source: definition.id,
      mode: definition.mode,
      observedDays: observed,
      ledOthers: lead?.ledOthers ?? 0,
      firstSightings: lead?.firstSightings ?? 0,
      delivered: delivered.get(definition.id) ?? 0,
      scoutVotes: reactions.get(definition.id)?.n ?? 0,
      scoutVotesAgainst: reactions.get(definition.id)?.against ?? 0,
      events,
      arrivals,
      corroborated,
      corroborationRate: arrivals ? Math.round((corroborated / arrivals) * 100) / 100 : null,
      heldBack: seen?.held ?? 0,
    };
    // Delivering a card is not the same as being worth one. A source the channel voted against more
    // often than for has been measured by its readers, and that measurement outranks the count of
    // what it managed to send; the Gemini models blog delivered one card and drew three thumbs down.
    const votedDown = row.scoutVotesAgainst >= 2 && row.scoutVotesAgainst > row.scoutVotes;
    const earning = row.ledOthers > 0 || row.delivered > 0 || row.scoutVotes > 0;
    return {
      ...row,
      verdict: votedDown ? "voted_down" : earning ? "earning" : row.heldBack > 0 ? "held_back" : "no_measurable_value",
    };
  };
  const rank: Record<SourceVerdict["verdict"], number> = {
    voted_down: 0,
    no_measurable_value: 1,
    held_back: 2,
    earning: 3,
  };
  const ordered = (rows: SourceVerdict[]) =>
    rows.sort((left, right) => rank[left.verdict] - rank[right.verdict] || left.source.localeCompare(right.source));
  const sources = ordered(enabled.filter((definition) => judged(definition.id)).map(verdictFor));
  const preliminary = ordered(enabled.filter((definition) => !judged(definition.id)).map(verdictFor));
  return { since, sources, notYetJudged, preliminary };
}
