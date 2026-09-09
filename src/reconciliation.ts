import type { Database } from "bun:sqlite";

export type ReconciliationResult = {
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
export function reconcileDelivery(db: Database, id: number, now = Date.now()): ReconciliationResult {
  const row = db
    .query<{ destination_id: string; status: string; reconcile_attempts: number }, [number]>(
      "SELECT destination_id,status,reconcile_attempts FROM deliveries WHERE id=?",
    )
    .get(id);
  if (!row) throw new Error(`Delivery ${id} not found`);
  if (row.status !== "ambiguous" && row.status !== "verification_required")
    throw new Error(`Delivery ${id} is ${row.status}; only unresolved deliveries can be reconciled`);

  const next = row.reconcile_attempts + 1;
  const changed = db
    .query<{ reconcile_attempts: number }, [number, string, number, number]>(
      `UPDATE deliveries
       SET status='verification_required',reconcile_attempts=?,last_reconcile_error=?,confirmation_source='manual_required',updated_at=?
       WHERE id=? AND status IN ('ambiguous','verification_required')
       RETURNING reconcile_attempts`,
    )
    .get(next, MANUAL_VERIFICATION, now, id);
  if (!changed) throw new Error(`Delivery ${id} changed before reconciliation could record its result`);
  return {
    id,
    status: "verification_required",
    attempts: changed.reconcile_attempts,
    destination: row.destination_id,
    message: MANUAL_VERIFICATION,
  };
}
