import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireDeliveryVerification, resolveDeliveryVerification } from "../deliveryVerification.js";
import { sentByChannel } from "../reports/news.js";
import { count, identifier, type OperationMap } from "./definition.js";

/** The "delivery" section of the operation registry; src/operations.ts joins the sections. */
export function deliveryOperations(db: Database, _config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
    deliveries: {
      section: "delivery",
      summary: "Recent delivery outcomes. Ambiguous sends require checking the destination.",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/deliveries" },
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_source,verified_at,verification_attempts,last_verification_error FROM deliveries ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    deliveries_needing_verification: {
      section: "delivery",
      summary: "Ambiguous or manually unresolved deliveries that must be checked without resending.",
      startHere: "a send may or may not have reached the channel",
      mutates: false,
      agent: true,
      schema: z.object({ limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/deliveries/verification" },
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error,verification_attempts,last_verification_error FROM deliveries WHERE status IN ('ambiguous','verification_required') ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
    require_delivery_verification: {
      section: "delivery",
      summary: "Mark one ambiguous delivery for manual verification; this never sends a second message.",
      mutates: true,
      agent: true,
      schema: z.object({ id: identifier }),
      cli: { args: [{ name: "id" }] },
      http: { method: "post", path: "/api/deliveries/:id/verification" },
      handler: (input: { id: number }) => requireDeliveryVerification(db, input.id),
    },
    resolve_delivery_verification: {
      section: "delivery",
      summary: "Record the result of manual delivery verification without sending a second message.",
      note: "Record what the destination actually shows. This decides the outcome; nothing re-reads it later.",
      mutates: true,
      agent: true,
      schema: z.object({
        id: identifier,
        outcome: z.enum(["sent", "failed"]),
        externalId: z.string().min(1).optional(),
      }),
      cli: { args: [{ name: "id" }, { name: "outcome" }, { name: "externalId", optional: true }] },
      http: {
        method: "post",
        path: "/api/deliveries/:id/verification/resolve",
        input: (request) => ({
          ...(request.body && typeof request.body === "object" ? request.body : {}),
          id: request.params.id,
        }),
      },
      handler: (input: { id: number; outcome: "sent" | "failed"; externalId?: string | undefined }) =>
        resolveDeliveryVerification(db, input.id, input.outcome, input.externalId),
    },
    suppressions: {
      section: "delivery",
      summary: "Events that were subscribed to but produced no message, with the rule and the reason in words.",
      startHere: "an event was collected but no subscriber saw it",
      mutates: false,
      agent: true,
      schema: z.object({ destinationId: z.string().min(1).optional(), limit: count(100, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/suppressions" },
      handler: (input: { destinationId?: string | undefined; limit: number }) =>
        db
          .query(
            `SELECT s.event_id,s.destination_id,s.batch_id,s.reason,s.detail,s.recorded_at,
                  e.source,e.stream,e.kind,e.entity_id
           FROM suppressions s JOIN events e ON e.id=s.event_id
           WHERE (?1 IS NULL OR s.destination_id=?1)
           ORDER BY s.recorded_at DESC, s.event_id DESC LIMIT ?2`,
          )
          .all(input.destinationId ?? null, input.limit),
    },
    sent: {
      section: "delivery",
      summary:
        "What each channel received over the last N hours (default 24): titles per message, newest first, with pending and failed counts.",
      startHere: "what went to signals, what went to scouts",
      mutates: false,
      agent: true,
      schema: z.object({ hours: count(168, 24), destination: z.string().min(1).optional() }),
      cli: {
        args: [
          { name: "hours", optional: true },
          { name: "destination", optional: true },
        ],
      },
      http: { method: "get", path: "/api/sent" },
      handler: (input: { hours: number; destination?: string | undefined }) => sentByChannel(db, input),
    },
  };
}
