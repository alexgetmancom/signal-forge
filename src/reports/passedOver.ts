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
  /**
   * The same count over arrivals alone, which is the one the corroboration rule does.
   *
   * A catalogue rewriting a row it already had is that catalogue repeating itself, not an
   * organisation noticing a model, so `detectCorroborated` counts only `kind='new'`. This count
   * says what the rule saw; `independentSourceCount` says what we held. Where they disagree the
   * subject is a catalogue catching up: every event on Gemini 3.8 Flash on 2026-09-27 was a
   * `changed`, three families by the wider count and none by this one, for a model Google had
   * shipped on 2 September.
   */
  arrivalSourceCount: number;
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
  /**
   * Subjects at or over the threshold on `arrivalSourceCount` that never spoke: the misses this
   * report exists for.
   *
   * Counted on arrivals because it is a claim about the corroboration rule, and a headline that
   * counts something the rule does not is a false alarm the operator has to disprove by hand. On
   * the seven days to 2026-09-27 the wider count made it 30 and the rule's own arithmetic made it
   * 11; the top two, Gemini 3.8 Flash and GLM 5.2 Fast, were models out since 2 September and 23
   * June that no reader was waiting for.
   */
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
  kind: string;
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
              e.id AS event_id,e.kind,e.source,e.stream,e.authority,src.vendor AS source_vendor,
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
export function passedOver(db: Database, days = 7, limit = 50, now = Date.now()): PassedOverReport {
  // The instant is an argument because it was read off the clock: three tests wrote fixed detection
  // times inside the default window, and passed until the day the window moved past them.
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const grouped = new Map<number, Row[]>();
  for (const row of rows(db, since)) grouped.set(row.story_id, [...(grouped.get(row.story_id) ?? []), row]);

  const stories: PassedOverStory[] = [];
  for (const [storyId, events] of grouped) {
    const first = events[0];
    if (!first) continue;
    const familyOf = (event: Row) =>
      sourceIndependenceFamily({
        source: event.source,
        stream: event.stream,
        authority: event.authority,
        vendor: event.source_vendor,
      });
    const families = new Set(events.map(familyOf));
    const arrivalFamilies = new Set(events.filter((event) => event.kind === "new").map(familyOf));
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
      arrivalSourceCount: arrivalFamilies.size,
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

  // Arrivals first, so the top of the table is what the rule could have carried. Ordering by the
  // wider count put Gemini 3.8 Flash and GLM 5.2 Fast in the first two rows on 2026-09-27, both
  // long since released, and a reader who trusts the ordering reads those as the day's worst
  // misses.
  stories.sort(
    (left, right) =>
      Number(left.spoke) - Number(right.spoke) ||
      right.arrivalSourceCount - left.arrivalSourceCount ||
      right.independentSourceCount - left.independentSourceCount ||
      right.suppressedCount - left.suppressedCount ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  return {
    days,
    threshold: INDEPENDENT_SOURCES,
    overThresholdAndSilent: stories.filter((story) => !story.spoke && story.arrivalSourceCount >= INDEPENDENT_SOURCES)
      .length,
    stories: stories.slice(0, limit),
  };
}
