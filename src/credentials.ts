import type { Database } from "bun:sqlite";

/**
 * A credential that was refused is a different failure from a link that dropped, and the per-source
 * backoff cannot tell them apart: it doubles the wait and keeps asking. A revoked key answers 401
 * every time, so asking again is guaranteed to fail, costs the upstream a rejected request, and
 * keeps a board red for a reason nobody can act on from the board.
 *
 * The circuit opens on the capability rather than the source. Three collectors carrying one
 * GITHUB_TOKEN were all refused by the same fact, and they come back the same way: the owner
 * rotates the credential and clears the circuit once.
 *
 * Nothing reopens on a timer. A key does not become valid again by waiting, and a collector that
 * silently resumed against a still-revoked credential is how the request budget was spent the first
 * time.
 */
export type CredentialCircuit = {
  capabilityId: string;
  state: "open" | "cleared";
  statusCode: number | null;
  source: string;
  detail: string;
  rejections: number;
  openedAt: string;
  lastRejectedAt: string;
  clearedAt: string | null;
};

export function isCredentialRejection(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/** Records one refusal. A circuit already open stays open and counts the repeat. */
export function recordCredentialRejection(
  db: Database,
  input: { capabilityId: string; source: string; statusCode: number | null; detail: string },
  now = Date.now(),
): void {
  const at = new Date(now).toISOString();
  db.query(
    `INSERT INTO credential_circuits(capability_id,state,status_code,source,detail,rejections,opened_at,last_rejected_at,cleared_at)
     VALUES(?1,'open',?2,?3,?4,1,?5,?5,NULL)
     ON CONFLICT(capability_id) DO UPDATE SET
       state='open',status_code=excluded.status_code,source=excluded.source,detail=excluded.detail,
       rejections=CASE WHEN credential_circuits.state='open' THEN credential_circuits.rejections+1 ELSE 1 END,
       opened_at=CASE WHEN credential_circuits.state='open' THEN credential_circuits.opened_at ELSE excluded.opened_at END,
       last_rejected_at=excluded.last_rejected_at,cleared_at=NULL`,
  ).run(input.capabilityId, input.statusCode, input.source, input.detail, at);
}

export function openCredentialCircuits(db: Database): CredentialCircuit[] {
  return db
    .query<
      {
        capability_id: string;
        state: "open" | "cleared";
        status_code: number | null;
        source: string;
        detail: string;
        rejections: number;
        opened_at: string;
        last_rejected_at: string;
        cleared_at: string | null;
      },
      []
    >(
      "SELECT capability_id,state,status_code,source,detail,rejections,opened_at,last_rejected_at,cleared_at FROM credential_circuits WHERE state='open' ORDER BY capability_id",
    )
    .all()
    .map((row) => ({
      capabilityId: row.capability_id,
      state: row.state,
      statusCode: row.status_code,
      source: row.source,
      detail: row.detail,
      rejections: row.rejections,
      openedAt: row.opened_at,
      lastRejectedAt: row.last_rejected_at,
      clearedAt: row.cleared_at,
    }));
}

export function openCredentialCircuitIds(db: Database): Set<string> {
  return new Set(
    db
      .query<{ capability_id: string }, []>("SELECT capability_id FROM credential_circuits WHERE state='open'")
      .all()
      .map((row) => row.capability_id),
  );
}

export type CredentialCircuitResolution = {
  capabilityId: string;
  state: "cleared";
  rejections: number;
  clearedAt: string;
  message: string;
};

/**
 * The owner says the credential is good again. The state this clears was written under the
 * condition that it was open, so the clearing write carries that condition too.
 */
export function clearCredentialCircuit(
  db: Database,
  capabilityId: string,
  now = Date.now(),
): CredentialCircuitResolution {
  const clearedAt = new Date(now).toISOString();
  const changed = db
    .query<{ rejections: number }, [string, string]>(
      "UPDATE credential_circuits SET state='cleared',cleared_at=?2 WHERE capability_id=?1 AND state='open' RETURNING rejections",
    )
    .get(capabilityId, clearedAt);
  if (!changed) throw new Error(`No open credential circuit for ${capabilityId}`);
  return {
    capabilityId,
    state: "cleared",
    rejections: changed.rejections,
    clearedAt,
    message: `Sources requiring ${capabilityId} will be scheduled again on the next cycle`,
  };
}
