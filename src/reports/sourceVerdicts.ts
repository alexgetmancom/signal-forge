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
 */
export type SourceVerdict = {
  source: string;
  mode: string;
  ledOthers: number;
  firstSightings: number;
  delivered: number;
  scoutVotes: number;
  verdict: "earning" | "no_measurable_value";
};

export function sourceVerdicts(
  db: Database,
  config: AppConfig,
  days = 30,
  now = Date.now(),
): { since: string; sources: SourceVerdict[]; notYetJudged: { source: string; collectingSince: string | null }[] } {
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
  const sources = enabled
    .filter((definition) => judged(definition.id))
    .map((definition): SourceVerdict => {
      const lead = leads.get(definition.id);
      const row = {
        source: definition.id,
        mode: definition.mode,
        ledOthers: lead?.ledOthers ?? 0,
        firstSightings: lead?.firstSightings ?? 0,
        delivered: delivered.get(definition.id) ?? 0,
        scoutVotes: votes.get(definition.id) ?? 0,
      };
      const earning = row.ledOthers > 0 || row.delivered > 0 || row.scoutVotes > 0;
      return { ...row, verdict: earning ? "earning" : "no_measurable_value" };
    })
    .sort(
      (left, right) =>
        Number(left.verdict === "earning") - Number(right.verdict === "earning") ||
        left.source.localeCompare(right.source),
    );
  return { since, sources, notYetJudged };
}
