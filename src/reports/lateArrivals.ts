import type { Database } from "bun:sqlite";
import { CREATED_FIELDS, recordReleaseDate } from "../events/releaseDate.js";

/**
 * Of what actually reached a channel, how old it already was.
 *
 * The inverse of `release-audit`, and the direction that catches a mistake rather than measuring a
 * success. That report starts from the models released in the window and asks how quickly each was
 * caught, so a model published two years ago cannot appear in it at all -- which is exactly the
 * shape of the failure it needs to catch. On 2026-10-04 a second Hugging Face listing was added,
 * fifty repositories per organisation were read for the first time, and 25 of them became cards;
 * `microsoft/phi-4` was published on 2024-12-11. `release-audit` was clean that day. The channel
 * found it, by leaving a thumb down.
 *
 * So this starts from the cards instead and asks the publisher's own date of each. A healthy day is
 * a list of small numbers: a model is announced and read within hours. A widened window, a new
 * organisation or a collector that started reading a back catalogue all look the same here and all
 * look wrong immediately -- a cluster of large ages, detected in one minute, usually from one
 * source.
 *
 * It reports what was held as well, because the two numbers are only meaningful together: late
 * sightings held is the rule working, late sightings sent is the rule having a gap.
 *
 * "Sent" is a card that named this event, read through `delivery_events` -- the same link
 * `release-audit` reads, so the two reports cannot disagree about what a card is. The batch is the
 * wrong unit here: one batch carried 402 OpenCode rows in a second and every one of them would have
 * counted as delivered through it.
 */
export type LateArrivals = {
  days: number;
  summary: {
    /** Dated sightings that reached a channel, which is what the ages below are drawn from. */
    delivered: number;
    /** Of those, the ones their publisher dated more than a month before this deployment read them. */
    deliveredLate: number;
    /** The same question asked of the sightings a rule stopped: the gap's other side. */
    heldLate: number;
    medianAgeDays: number | null;
    oldestAgeDays: number | null;
  };
  /** The late ones that were sent, worst first: the rows to explain, by `why <id>`. */
  sent: LateArrival[];
  /** Which sources the late sends came from, because the cause is nearly always one of them. */
  bySource: { source: string; sent: number; late: number }[];
};

type LateArrival = {
  eventId: number;
  source: string;
  entityId: string;
  publishedAt: string;
  detectedAt: string;
  ageDays: number;
};

type Row = {
  id: number;
  source: string;
  entity_id: string;
  detected_at: string;
  delivered: number;
} & Record<string, unknown>;

/**
 * The date fields only, never the body.
 *
 * Built from `CREATED_FIELDS` rather than written out, so a spelling added to the reader is asked
 * of the database by the same change. Selecting `after_json` here would have cost what the archive
 * has grown to for an answer that keeps one number per row, which is what `check-sql` refuses.
 */
const DATE_COLUMNS = CREATED_FIELDS.map((field) => `json_extract(e.after_json,'$.${field}') AS "${field}"`).join(",");

/** A month, the same month `published_long_before_we_read_it` holds a sighting for. */
const LATE_DAYS = 30;

export function lateArrivals(db: Database, days: number, limit: number): LateArrivals {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  // Only the streams where a record is a model being listed and `created` is the model's own date;
  // the same scope the standing rule uses, so the two cannot disagree about what they are counting.
  const rows = db
    .query<Row, [string]>(
      `SELECT e.id, e.source, e.entity_id, e.detected_at, ${DATE_COLUMNS},
              EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
                     WHERE de.event_id=e.id AND d.status='sent') AS delivered
         FROM events e
        WHERE e.kind='new' AND e.detected_at >= ?
          AND e.stream IN ('api-models','openrouter','weights')
        ORDER BY e.detected_at DESC`,
    )
    .all(since);

  const aged = rows.flatMap((row) => {
    const published = recordReleaseDate(row);
    if (published === null) return [];
    const ageDays = (Date.parse(row.detected_at) - published) / 86_400_000;
    return [{ row, published, ageDays }];
  });

  const delivered = aged.filter((one) => one.row.delivered);
  const late = delivered.filter((one) => one.ageDays > LATE_DAYS).sort((a, b) => b.ageDays - a.ageDays);
  const ages = delivered.map((one) => one.ageDays).sort((a, b) => a - b);
  const bySource = new Map<string, { sent: number; late: number }>();
  for (const one of delivered) {
    const seen = bySource.get(one.row.source) ?? { sent: 0, late: 0 };
    bySource.set(one.row.source, { sent: seen.sent + 1, late: seen.late + (one.ageDays > LATE_DAYS ? 1 : 0) });
  }

  return {
    days,
    summary: {
      delivered: delivered.length,
      deliveredLate: late.length,
      heldLate: aged.filter((one) => !one.row.delivered && one.ageDays > LATE_DAYS).length,
      medianAgeDays: ages.length ? round(ages[Math.floor(ages.length / 2)] ?? 0) : null,
      oldestAgeDays: ages.length ? round(ages.at(-1) ?? 0) : null,
    },
    sent: late.slice(0, limit).map((one) => ({
      eventId: one.row.id,
      source: one.row.source,
      entityId: one.row.entity_id,
      publishedAt: new Date(one.published).toISOString(),
      detectedAt: one.row.detected_at,
      ageDays: round(one.ageDays),
    })),
    bySource: [...bySource.entries()]
      .map(([source, counts]) => ({ source, ...counts }))
      .filter((one) => one.late > 0)
      .sort((a, b) => b.late - a.late),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
