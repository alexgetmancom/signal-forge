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

/**
 * What the work is told about the lease it is running under.
 *
 * `holder` is handed over rather than recomputed. `publications` used to fence its own write by
 * calling `lockHolder` a second time and comparing the strings, which only worked while the string
 * was a pure function of the process -- and a string that identifies an acquisition cannot be.
 */
export type HeldLease = { holder: string; signal: AbortSignal };

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
  run: (lease: HeldLease) => Promise<T> | T,
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
  // The lease keeps a second holder out; it does not keep the first one's work in. A process that
  // stalls past its expiry -- a long GC pause, a disk that stops answering -- loses the lease to
  // somebody else, wakes up, and carries on collecting: two cycles writing the same sources, which
  // is the exact thing the lock exists to prevent, and neither of them can tell. The renewal is the
  // only place that finds out, because it is the only thing that touches the row while the work
  // runs, so it is what says so.
  const lost = new AbortController();
  const renewal = setInterval(() => {
    try {
      const renewed = db
        .query("UPDATE action_locks SET expires_at=? WHERE name=? AND holder=?")
        .run(new Date(Date.now() + leaseMs).toISOString(), name, holder);
      if (renewed.changes === 0 && !lost.signal.aborted)
        lost.abort(new Error(`Lease ${name} was taken by another holder`));
    } catch {
      // A renewal that cannot be written leaves the lease to expire on its own, which is the
      // behaviour a crashed holder gets and is safe; the cycle itself is not worth failing for it.
      // Losing the row to somebody else is the other case, and it is handled above, not here.
    }
  }, renewalInterval(leaseMs));
  try {
    return { acquired: true, result: await run({ holder, signal: lost.signal }) };
  } finally {
    clearInterval(renewal);
    db.query("DELETE FROM action_locks WHERE name=? AND holder=?").run(name, holder);
  }
}

/** Renew often enough that two missed renewals still leave the lease standing. */
function renewalInterval(leaseMs: number): number {
  return Math.max(1_000, Math.floor(leaseMs / 4));
}

/**
 * Identifies one acquisition of a lease, well enough to name it in an operator message and well
 * enough that no other acquisition can be mistaken for it.
 *
 * The pid alone is not enough on its own terms: a container starts its processes at low numbers and
 * reuses them across restarts, so `poller:7` after a crash is the same string as the `poller:7`
 * whose row may still be sitting in the table. Release and renewal both match on this string, and
 * both are wrong if two acquisitions can share one.
 */
export function lockHolder(surface: string): string {
  return `${surface}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}
