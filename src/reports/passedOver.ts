import type { Database } from "bun:sqlite";
import { corroborationOf, INDEPENDENT_SOURCES } from "../events/corroboration.js";
import { sourceIndependenceFamily } from "../events/sourceFamily.js";
import type { SourceAuthority } from "../events/types.js";

/**
 * What the deployment collected about a subject and never said out loud.
 *
 * `signal_quality` counts suppressions by source and `channel_mix` counts what each channel
 * carried; both are counts of events, and an event is the wrong unit for this question. Nobody
 * asked "was that one gateway listing worth a card" -- the answer was no, correctly, four times
 * running. The question is "how much did we know about this model before a reader heard of it",
 * and that is a question about a subject, which only `stories` groups.
 *
 * So this is the stories that stayed silent, ordered by how much agreement they accumulated while
 * they did. A row near the top with no card is either a threshold set too high or a rule that
 * should not have applied; a row near the top with a card is the mechanism working, kept in the
 * table so the two can be told apart.
 *
 * The reasons are here because they are the actionable half. Step 5 Preview was passed over as a
 * board row, a small maker's listing and a mirror -- three different rules, none of them wrong,
 * and reading them in one line is what shows they were all the same miss.
 */
type PassedOverStory = {
  storyId: number;
  title: string;
  vendor: string | null;
  independentSourceCount: number;
  sources: string[];
  eventCount: number;
  suppressedCount: number;
  /** Which rules kept it quiet, most frequent first: "below_the_top_of_the_board × 2". */
  reasons: { reason: string; count: number }[];
  firstSeenAt: string;
  updatedAt: string;
  /** Whether any card about this subject ever reached a reader. */
  spoke: boolean;
  /** Whether the corroboration rule sent it, and with how many sources when it did. */
  cardedByCorroboration: number | null;
};

export type PassedOverReport = {
  days: number;
  threshold: number;
  /** Subjects at or over the threshold that never spoke: the misses this report exists for. */
  overThresholdAndSilent: number;
  stories: PassedOverStory[];
};

type Row = {
  story_id: number;
  title: string;
  vendor: string | null;
  first_seen_at: string;
  updated_at: string;
  event_id: number;
  source: string;
  stream: string;
  authority: SourceAuthority;
  source_vendor: string | null;
  delivered: number;
  suppressions: number;
  reasons: string | null;
};

/**
 * One row per event of every story touched in the period, carrying the event's own delivery and
 * suppression counts. Suppressions are per destination, so an event held back from two channels is
 * two rows there and the count says two: the number is how many times a rule fired, which is what
 * a threshold is tuned against.
 */
function rows(db: Database, since: string): Row[] {
  return db
    .query<Row, [string]>(
      `SELECT s.id AS story_id,s.title,s.vendor,s.first_seen_at,s.updated_at,
              e.id AS event_id,e.source,e.stream,e.authority,src.vendor AS source_vendor,
              EXISTS(SELECT 1 FROM batch_events be JOIN deliveries d ON d.batch_id=be.batch_id
                     WHERE be.event_id=e.id) AS delivered,
              (SELECT COUNT(*) FROM suppressions sup WHERE sup.event_id=e.id) AS suppressions,
              (SELECT GROUP_CONCAT(sup.reason) FROM suppressions sup WHERE sup.event_id=e.id) AS reasons
       FROM stories s
       JOIN story_events se ON se.story_id=s.id
       JOIN events e ON e.id=se.event_id
       LEFT JOIN sources src ON src.id=e.source
       WHERE s.updated_at>=?
       ORDER BY s.id,e.detected_at,e.id`,
    )
    .all(since);
}

/**
 * Every subject of the period with what we knew and whether we said it, the ones that accumulated
 * most agreement in silence first.
 *
 * Subjects that spoke are kept rather than filtered: a report that only lists misses cannot show
 * that the rule is now catching them, and an operator comparing the two is the point.
 */
export function passedOver(db: Database, days = 7, limit = 50): PassedOverReport {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const grouped = new Map<number, Row[]>();
  for (const row of rows(db, since)) grouped.set(row.story_id, [...(grouped.get(row.story_id) ?? []), row]);

  const stories: PassedOverStory[] = [];
  for (const [storyId, events] of grouped) {
    const first = events[0];
    if (!first) continue;
    const families = new Set(
      events.map((event) =>
        sourceIndependenceFamily({
          source: event.source,
          stream: event.stream,
          authority: event.authority,
          vendor: event.source_vendor,
        }),
      ),
    );
    const tally = new Map<string, number>();
    for (const event of events)
      for (const reason of (event.reasons ?? "").split(",").filter(Boolean))
        tally.set(reason, (tally.get(reason) ?? 0) + 1);
    const carded = corroborationOf(db, storyId);
    stories.push({
      storyId,
      title: first.title,
      vendor: first.vendor,
      independentSourceCount: families.size,
      sources: [...new Set(events.map((event) => event.source))].sort(),
      eventCount: events.length,
      suppressedCount: events.reduce((total, event) => total + event.suppressions, 0),
      reasons: [...tally]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      firstSeenAt: first.first_seen_at,
      updatedAt: first.updated_at,
      spoke: events.some((event) => event.delivered === 1),
      cardedByCorroboration: carded ? carded.families.length : null,
    });
  }

  stories.sort(
    (left, right) =>
      Number(left.spoke) - Number(right.spoke) ||
      right.independentSourceCount - left.independentSourceCount ||
      right.suppressedCount - left.suppressedCount ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  return {
    days,
    threshold: INDEPENDENT_SOURCES,
    overThresholdAndSilent: stories.filter(
      (story) => !story.spoke && story.independentSourceCount >= INDEPENDENT_SOURCES,
    ).length,
    stories: stories.slice(0, limit),
  };
}
