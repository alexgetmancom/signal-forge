import type { Database } from "bun:sqlite";
import { signalClass } from "./events/signals.js";
import type { Event } from "./events/types.js";

/**
 * What each channel actually carried, as opposed to what the routing says it should.
 *
 * Every argument about the shape of the feed so far has been settled by looking at a screenshot:
 * the public channel was flooded overnight and the fix was chosen from one reading of one morning.
 * That is a way to be wrong slowly. These are the three numbers the decisions actually turn on --
 * how much of each class reaches a reader, how often a card can say it saw something first, and
 * whether the invited room ever promotes anything -- taken from delivered rows rather than from
 * intent.
 */
export type ChannelMixReport = {
  since: string;
  days: number;
  classes: { signal: string; events: number; delivered: number }[];
  destinations: { id: string; sent: number; failed: number; withLead: number; leadShare: number }[];
  promotions: { batches: number; sent: number };
};

/** The line a card prints when another source carried the same story first. */
const LEAD_MARK = "Traced ";

const rounded = (value: number): number => Math.round(value * 100) / 100;

export function channelMix(db: Database, days = 7, now = Date.now()): ChannelMixReport {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Channel mix days must be between 1 and 90");
  const since = new Date(now - days * 24 * 3_600_000).toISOString();

  const events = db
    .query<Event & { delivered: number }, [string]>(
      `SELECT e.*, (SELECT COUNT(*) FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
                    WHERE de.event_id=e.id AND d.status='sent') AS delivered
       FROM events e WHERE e.detected_at>=?`,
    )
    .all(since);
  const classes = new Map<string, { events: number; delivered: number }>();
  for (const event of events) {
    const signal = signalClass(event) || "unclassified";
    const held = classes.get(signal) ?? { events: 0, delivered: 0 };
    held.events += 1;
    if (event.delivered > 0) held.delivered += 1;
    classes.set(signal, held);
  }

  const destinations = db
    .query<{ id: string; sent: number; failed: number; withLead: number }, [string, string]>(
      `SELECT d.destination_id AS id,
              SUM(CASE WHEN d.status='sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN d.status IN ('failed','ambiguous') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN d.status='sent' AND d.body LIKE ? THEN 1 ELSE 0 END) AS withLead
       FROM deliveries d WHERE d.updated_at>=? GROUP BY d.destination_id ORDER BY d.destination_id`,
    )
    .all(`%${LEAD_MARK}%`, since);

  const promotions = db
    .query<{ batches: number; sent: number }, [string]>(
      `SELECT COUNT(DISTINCT b.id) AS batches,
              COUNT(CASE WHEN d.status='sent' THEN 1 END) AS sent
       FROM batches b LEFT JOIN deliveries d ON d.batch_id=b.id
       WHERE b.kind='promotion' AND b.ready_at>=?`,
    )
    .get(since) ?? { batches: 0, sent: 0 };

  return {
    since,
    days,
    classes: [...classes.entries()]
      .map(([signal, counts]) => ({ signal, ...counts }))
      .sort((one, other) => other.events - one.events),
    destinations: destinations.map((row) => ({
      ...row,
      // How often the wire could say it saw something before the rest of the internet did, which is
      // the whole claim the service makes.
      leadShare: row.sent ? rounded(row.withLead / row.sent) : 0,
    })),
    promotions,
  };
}
