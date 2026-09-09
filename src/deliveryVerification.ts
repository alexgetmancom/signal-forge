import type { Database } from "bun:sqlite";

export type DeliveryVerificationResult = {
  id: number;
  status: "verification_required";
  attempts: number;
  destination: string;
  message: string;
};

export type DeliveryVerificationResolution = {
  id: number;
  status: "sent" | "failed";
  attempts: number;
  destination: string;
  verifiedAt: string;
  message: string;
};

const MANUAL_VERIFICATION =
  "No reliable read-back is available for this destination; verify the destination manually before deciding its outcome";

/**
 * Ambiguous sends are never replayed. Telegram and Discord cannot reliably locate a message after
 * a lost response without a provider ID, so this records an explicit manual-verification state.
 */
export function requireDeliveryVerification(db: Database, id: number, now = Date.now()): DeliveryVerificationResult {
  const row = db
    .query<{ destination_id: string; status: string; verification_attempts: number }, [number]>(
      "SELECT destination_id,status,verification_attempts FROM deliveries WHERE id=?",
    )
    .get(id);
  if (!row) throw new Error(`Delivery ${id} not found`);
  if (row.status !== "ambiguous" && row.status !== "verification_required")
    throw new Error(`Delivery ${id} is ${row.status}; only unresolved deliveries can require verification`);

  const next = row.verification_attempts + 1;
  const changed = db
    .query<{ verification_attempts: number }, [number, string, number, number]>(
      `UPDATE deliveries
       SET status='verification_required',verification_attempts=?,last_verification_error=?,verification_source='manual',updated_at=?
       WHERE id=? AND status IN ('ambiguous','verification_required')
       RETURNING verification_attempts`,
    )
    .get(next, MANUAL_VERIFICATION, now, id);
  if (!changed) throw new Error(`Delivery ${id} changed before verification could be recorded`);
  return {
    id,
    status: "verification_required",
    attempts: changed.verification_attempts,
    destination: row.destination_id,
    message: MANUAL_VERIFICATION,
  };
}

export function resolveDeliveryVerification(
  db: Database,
  id: number,
  outcome: "sent" | "failed",
  externalId?: string,
  now = Date.now(),
): DeliveryVerificationResolution {
  const verifiedAt = new Date(now).toISOString();
  const message =
    outcome === "sent"
      ? "Manual verification recorded the delivery as sent"
      : "Manual verification found no message at the destination";
  const changed = db
    .query<
      { destination_id: string; attempts: number },
      [string, string | null, string | null, string, number, number]
    >(
      `UPDATE deliveries
       SET status=?,external_id=COALESCE(?,external_id),error=?,verification_source='manual',verified_at=?,last_verification_error=NULL,updated_at=?
       WHERE id=? AND status IN ('ambiguous','verification_required')
       RETURNING destination_id,attempts`,
    )
    .get(outcome, externalId ?? null, outcome === "sent" ? null : message, verifiedAt, now, id);
  if (!changed) throw new Error(`Delivery ${id} is not awaiting manual verification`);
  if (outcome === "failed")
    db.query(
      "UPDATE deliveries SET status='failed',error='Earlier message part was not confirmed',updated_at=? WHERE batch_id=(SELECT batch_id FROM deliveries WHERE id=?) AND destination_id=(SELECT destination_id FROM deliveries WHERE id=?) AND part>(SELECT part FROM deliveries WHERE id=?) AND status='pending'",
    ).run(now, id, id, id);
  return {
    id,
    status: outcome,
    attempts: changed.attempts,
    destination: changed.destination_id,
    verifiedAt,
    message,
  };
}
