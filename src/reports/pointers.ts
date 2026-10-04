import type { Database } from "bun:sqlite";

/**
 * Where every moving pointer aims, what has moved, and which listings are dated to end.
 *
 * `~openai/gpt-sol-latest` is what a caller gets when they ask for no version, so the pointer
 * moving is the only thing a catalogue does that changes what an unchanged line of somebody's code
 * is served. Until 2026-10-04 the target was not stored at all and the move left no trace: an alias
 * repeats its target's numbers, so its only shadow was a price change, and those are silenced as
 * the day's net move. Of the 1,051 changed events the eighteen aliases produced in 26 days, 1,035
 * were pricing alone and eleven of the rest were a colon being added to a name.
 *
 * Now the target is stored, and this is where it is read. Not a card: a pointer has not moved in
 * the forty-four hours of catalogue bodies retained nor detectably in the twenty-six days of
 * events, so the class and the channel for a card nobody has seen would be a guess. What the move
 * cannot be is invisible -- the daily recap is assembled from fixed sections and this fits none of
 * them, which leaves the one honest place for a rare thing: somewhere to ask.
 *
 * The expiry dates ride along because they are the same half of the catalogue -- the fields about a
 * date rather than a capability -- and they are deliberately silent too. Thirty-three listings
 * carried one on 2026-10-04 and no deprecation page here knew of a single one of them.
 */
export type PointersReport = {
  windowDays: number;
  /** Pointers whose target no catalogue here has ever listed: a model named before it is sighted. */
  unlistedTargets: number;
  pointers: Pointer[];
  moves: PointerMove[];
  /**
   * The reads where a pointer gained the field rather than changed it.
   *
   * Eighteen of these happened in one minute on 2026-10-04, when this service began storing the
   * target. They are kept out of `moves` because somebody asking what moved would otherwise read
   * eighteen rows that are this deployment starting to look, and counted here rather than dropped
   * because a reader of an empty `moves` deserves to know the difference between nothing moved and
   * nothing is being read.
   */
  firstRead: PointerMove[];
  expiring: ExpiringListing[];
};

type Pointer = {
  alias: string;
  title: string | null;
  target: string;
  /**
   * Whether any catalogue here has ever listed the model this now aims at.
   *
   * `false` is the interesting answer and the rare one -- all eighteen targets were listed on
   * 2026-10-04 -- because a pointer aiming at a name nothing has recorded is a model that exists
   * before it is announced.
   */
  targetListedHere: boolean;
  /** The day the router created the pointer, which is its own tell: see `moves`. */
  createdUpstream: string | null;
  source: string;
};

type PointerMove = {
  eventId: number;
  at: string;
  alias: string;
  /** Null for the read where this service began storing the field, which is not a move. */
  was: string | null;
  now: string | null;
};

type ExpiringListing = {
  id: string;
  title: string | null;
  source: string;
  expiresAt: string;
  /** Whole days from now, negative once the date has passed and the listing is still carried. */
  daysLeft: number;
  /** Whether `lifecycle-deadlines` holds this one, which is where a date is counted down from. */
  deadlineKnown: boolean;
};

const DAY_MS = 24 * 3_600_000;

export function pointers(db: Database, days = 30, now = Date.now()): PointersReport {
  const since = new Date(now - days * DAY_MS).toISOString();
  const listed = db.query<{ one: number }, [string]>("SELECT 1 AS one FROM records WHERE id=? LIMIT 1");
  // `json_extract` rather than the body, which is the shape check-sql pushes a read towards: this
  // asks for two strings out of every record that has one and never carries a record.
  const current = db
    .query<{ source: string; id: string; title: string | null; target: string; created: string | null }, []>(
      `SELECT source, id, json_extract(body,'$.name') AS title, json_extract(body,'$.aliasTarget') AS target,
              json_extract(body,'$.created') AS created
         FROM records WHERE json_extract(body,'$.aliasTarget') IS NOT NULL ORDER BY id`,
    )
    .all();
  const pointerRows: Pointer[] = current.map((row) => ({
    alias: row.id,
    title: row.title,
    target: row.target,
    targetListedHere: Boolean(listed.get(row.target)),
    createdUpstream: row.created,
    source: row.source,
  }));
  // Bounded by the window and a limit, and a move is rare enough that a limit is never the thing
  // that cuts the answer short.
  const moves = db
    .query<{ id: number; detected_at: string; entity_id: string; was: string | null; now: string | null }, [string]>(
      `SELECT id, detected_at, entity_id,
              json_extract(before_json,'$.aliasTarget') AS was,
              json_extract(after_json,'$.aliasTarget') AS now
         FROM events
        WHERE kind='changed' AND detected_at>=?
          AND json_extract(before_json,'$.aliasTarget') IS NOT json_extract(after_json,'$.aliasTarget')
        ORDER BY id DESC LIMIT 200`,
    )
    .all(since);
  const seen: PointerMove[] = moves.map((row) => ({
    eventId: row.id,
    at: row.detected_at,
    alias: row.entity_id,
    was: row.was,
    now: row.now,
  }));
  const deadline = db.query<{ one: number }, [string]>(
    "SELECT 1 AS one FROM lifecycle_deadlines WHERE stable_key=? LIMIT 1",
  );
  const expiring = db
    .query<{ source: string; id: string; title: string | null; expires: string }, []>(
      `SELECT source, id, json_extract(body,'$.name') AS title, json_extract(body,'$.expirationDate') AS expires
         FROM records WHERE json_extract(body,'$.expirationDate') IS NOT NULL`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      source: row.source,
      expiresAt: row.expires,
      daysLeft: Math.floor((Date.parse(`${row.expires}T00:00:00.000Z`) - now) / DAY_MS),
      deadlineKnown: Boolean(deadline.get(`${row.source}:${row.id}:shutdown`)),
    }))
    .sort((left, right) => left.daysLeft - right.daysLeft || left.id.localeCompare(right.id));
  return {
    windowDays: days,
    unlistedTargets: pointerRows.filter((pointer) => !pointer.targetListedHere).length,
    pointers: pointerRows,
    moves: seen.filter((move) => move.was !== null && move.now !== null),
    firstRead: seen.filter((move) => move.was === null || move.now === null),
    expiring,
  };
}
