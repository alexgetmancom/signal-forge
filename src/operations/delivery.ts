import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireDeliveryVerification, resolveDeliveryVerification } from "../deliveryVerification.js";
import { sentByChannel } from "../reports/news.js";
import { count, identifier, type OperationMap } from "./definition.js";

/** The "delivery" section of the operation registry; src/operations.ts joins the sections. */
export function deliveryOperations(db: Database, _config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
    resend: {
      section: "delivery",
      summary: "Send one event's card again, to the channels that already had it.",
      note:
        "For a card that went out wrong and was deleted: a second card is normally worse than an " +
        "unclear one, so this is asked for by hand and journalled. It queues a fresh card from the " +
        "event as it stands now, which is only worth doing once whatever made the first one wrong " +
        "has been fixed. An event that shared its message with others can be resent too: the new " +
        "card is built from this event alone, so the others do not go out again.",
      mutates: true,
      // Sending to subscribers is the operator's call, never an agent's.
      agent: false,
      schema: z.object({ eventId: identifier }),
      cli: { args: [{ name: "event-id" }] },
      handler: (input: { eventId: number }) => {
        const event = db
          .query<{ id: number; source: string; entity_id: string }, [number]>(
            "SELECT id,source,entity_id FROM events WHERE id=?",
          )
          .get(input.eventId);
        if (!event) throw new Error(`No event ${input.eventId}`);
        const sent = db
          .query<{ destination_id: string; destination_json: string; url: string; signal: string }, [number]>(
            `SELECT d.destination_id,d.destination_json,
                    COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),'') AS url,
                    COALESCE(e.signal,'') AS signal
             FROM deliveries d JOIN delivery_events de ON de.delivery_id=d.id JOIN events e ON e.id=de.event_id
             WHERE de.event_id=?1 AND d.status='sent'
             GROUP BY d.destination_id`,
          )
          .all(input.eventId);
        if (sent.length === 0)
          throw new Error(`Event ${input.eventId} was never delivered, so there is nowhere to send it again`);
        const queued = db.transaction(() => {
          const batch = db
            .query<{ id: number }, [string, string]>(
              "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,0,?,'event',NULL) RETURNING id",
            )
            .get(event.source, new Date().toISOString());
          if (!batch) throw new Error("Resend batch insert failed");
          db.query("INSERT INTO batch_events(batch_id,event_id,url,signal) VALUES(?,?,?,?)").run(
            batch.id,
            event.id,
            sent[0]?.url ?? "",
            sent[0]?.signal ?? "",
          );
          for (const target of sent)
            db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
              batch.id,
              target.destination_id,
              target.destination_json,
            );
          return batch.id;
        })();
        return {
          event: event.entity_id,
          batch: queued,
          destinations: sent.map((target) => target.destination_id),
          message: "A fresh card is queued; the next delivery cycle sends it",
        };
      },
    },
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
