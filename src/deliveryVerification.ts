import type { Database } from "bun:sqlite";

export type DeliveryVerificationResult = {
  id: number;
  status: "verification_required";
  attempts: number;
  destination: string;
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
