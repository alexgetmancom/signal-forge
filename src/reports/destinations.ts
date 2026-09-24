import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";

/**
 * The channels this deployment actually sends to, and what each of them last heard.
 *
 * `sources` has this problem solved and `deliveries` does not. The sources table keeps a row for
 * every collector that ever ran and the reports filter it by the registry, which is why a retired
 * board reads as retired rather than broken. Destinations had no such report, so the only way to
 * ask which channels exist was to read the routing table off the host -- and the alternative,
 * grouping `deliveries` by destination_id, counts every channel that was ever configured.
 *
 * That alternative was taken on 2026-09-24 and produced "five of eight channels keep no delivery
 * records". Three destinations are configured. Five of those eight had been retired, two of the
 * three live ones keep perfect records, and the third had sixteen unlinked deliveries from a single
 * batch nine days earlier. The conclusion was wrong in every part, and the query was the reason.
 *
 * So the registry answers first, and history is read through it.
 */
export type DestinationStanding = {
  id: string;
  platform: string;
  live: boolean;
  signals: string[];
  sent: number;
  failed: number;
  pending: number;
  /** Deliveries of event cards that recorded nothing about which events they carried. */
  unlinkedCards: number;
  lastSent: string | null;
  quietDays: number | null;
  /**
   * Set when the two halves disagree and one of them is wrong.
   *
   * A destination absent from the registry that sent something yesterday is not retired -- it is a
   * registry that is not the one doing the sending, which is what reading this report against a
   * local `signal-forge.json` gives you. The same trap as `data/app.db`, one file over: the answer
   * looks complete and is quietly about a different deployment.
   */
  attention?: string;
};

/** Sending this recently is not what retirement looks like. */
const RECENTLY_ACTIVE_DAYS = 2;

export function destinationStandings(
  db: Database,
  config: AppConfig,
  days: number,
  now = new Date(),
): DestinationStanding[] {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const configured = config.destinations;
  const known = new Set(configured.map((destination) => destination.id));
  // A destination that no longer exists still has history, and hiding it is how the same mistake
  // gets made from the other side. It is listed, and it is marked.
  const retired = db
    .query<{ destination_id: string }, [string]>(
      "SELECT DISTINCT destination_id FROM deliveries WHERE updated_at>=? ORDER BY destination_id",
    )
    .all(from)
    .map((row) => row.destination_id)
    .filter((id) => !known.has(id));

  const standing = (id: string, platform: string, live: boolean, signals: string[]): DestinationStanding => {
    const counts = db
      .query<{ sent: number; failed: number; pending: number; last_sent: string | null }, [string, string]>(
        `SELECT
           SUM(status='sent') sent,
           SUM(status='failed') failed,
           SUM(status='pending') pending,
           MAX(CASE WHEN status='sent' THEN updated_at END) last_sent
         FROM deliveries WHERE destination_id=? AND updated_at>=?`,
      )
      .get(id, from);
    const unlinked = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) n FROM deliveries d JOIN batches b ON b.id=d.batch_id
         WHERE d.destination_id=? AND d.updated_at>=? AND d.status='sent' AND b.kind='event'
           AND NOT EXISTS (SELECT 1 FROM delivery_events de WHERE de.delivery_id=d.id)`,
      )
      .get(id, from);
    const lastSent = counts?.last_sent ?? null;
    const quietDays = lastSent ? Math.floor((now.getTime() - Date.parse(lastSent)) / 86_400_000) : null;
    const unregisteredButActive = !live && quietDays !== null && quietDays <= RECENTLY_ACTIVE_DAYS;
    return {
      id,
      platform,
      live,
      signals,
      sent: counts?.sent ?? 0,
      failed: counts?.failed ?? 0,
      pending: counts?.pending ?? 0,
      unlinkedCards: unlinked?.n ?? 0,
      lastSent,
      quietDays,
      ...(unregisteredButActive
        ? {
            attention:
              "Sent within the last two days but is not in this deployment's registry: the config being read is probably not the one delivering.",
          }
        : {}),
    };
  };

  return [
    ...configured.map((destination) => standing(destination.id, destination.platform, true, destination.signals ?? [])),
    ...retired.map((id) => standing(id, "unknown", false, [])),
  ];
}
