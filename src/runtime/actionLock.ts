import type { Database } from "bun:sqlite";

/**
 * One holder at a time, enforced by the database rather than by the process, because the two
 * callers that collide are two processes: `bun run poll` from the CLI and the source worker in the
 * running service, both against one SQLite file.
 *
 * A lease, not a mutex: a holder that is killed mid-cycle leaves its row behind, and nothing would
 * ever take the lock again. The expiry is what a crashed holder releases with.
 *
 * The lease is short and renewed while the work runs, rather than long enough to cover the slowest
 * cycle. A lease long enough for that is also long enough for a crashed holder to hold every other
 * process off past the point where sources are called stale: a fifteen-minute lease against a
 * fifteen-minute staleness threshold turned one crash into a wave of "collector down" alerts for
 * every source polled every five minutes. Renewal keeps a slow cycle safe without making a dead
 * one expensive.
 */
type ActionLease = {
  name: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
};

export type LockOutcome<T> = { acquired: true; result: T } | { acquired: false; heldBy: ActionLease };

function currentLease(db: Database, name: string): ActionLease | null {
  const row = db
    .query<{ holder: string; acquired_at: string; expires_at: string }, [string]>(
      "SELECT holder,acquired_at,expires_at FROM action_locks WHERE name=?",
    )
    .get(name);
  return row ? { name, holder: row.holder, acquiredAt: row.acquired_at, expiresAt: row.expires_at } : null;
}

/**
 * The condition the write was made under travels in the `WHERE`: a lease is taken only when no row
 * exists or the one that does has expired, and it is released only by the holder that owns it.
 */
export async function withActionLock<T>(
  db: Database,
  name: string,
  holder: string,
  leaseMs: number,
  run: () => Promise<T> | T,
): Promise<LockOutcome<T>> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  const taken = db
    .query<{ holder: string }, [string, string, string, string, string]>(
      `INSERT INTO action_locks(name,holder,acquired_at,expires_at) VALUES(?1,?2,?3,?4)
       ON CONFLICT(name) DO UPDATE SET holder=?2,acquired_at=?3,expires_at=?4
       WHERE action_locks.expires_at <= ?5
       RETURNING holder`,
    )
    .get(name, holder, now, expiresAt, now);
  if (!taken) {
    const held = currentLease(db, name);
    return {
      acquired: false,
      heldBy: held ?? { name, holder: "unknown", acquiredAt: now, expiresAt: now },
    };
  }
  const renewal = setInterval(() => {
    try {
      db.query("UPDATE action_locks SET expires_at=? WHERE name=? AND holder=?").run(
        new Date(Date.now() + leaseMs).toISOString(),
        name,
        holder,
      );
    } catch {
      // A renewal that cannot be written leaves the lease to expire on its own, which is the
      // behaviour a crashed holder gets and is safe; the cycle itself is not worth failing for it.
    }
  }, renewalInterval(leaseMs));
  try {
    return { acquired: true, result: await run() };
  } finally {
    clearInterval(renewal);
    db.query("DELETE FROM action_locks WHERE name=? AND holder=?").run(name, holder);
  }
}

/** Renew often enough that two missed renewals still leave the lease standing. */
function renewalInterval(leaseMs: number): number {
  return Math.max(1_000, Math.floor(leaseMs / 4));
}

/** Identifies the process holding a lease well enough to name it in an operator message. */
export function lockHolder(surface: string): string {
  return `${surface}:${process.pid}`;
}
