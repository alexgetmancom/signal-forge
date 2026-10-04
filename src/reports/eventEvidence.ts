import type { Database } from "bun:sqlite";
import { corroborationOfEvent } from "../events/corroboration.js";
import { lifecycleState } from "../events/lifecycleState.js";
import type { Event } from "../events/types.js";

/**
 * One event, and what became of it.
 *
 * The command this backs asks "what does this claim actually rest on", and for a long time it
 * answered `SELECT * FROM events WHERE id=?`: the columns, and nothing about whether anybody was
 * ever told. The gap is not cosmetic. `speaks` is the standing verdict -- no rule vetoed this event
 * -- and it is the column a reader of the row reaches for when they want to know if it was sent,
 * because it is the only one that sounds like an answer. It is not one. On 2026-10-04 four removals
 * out of Claude Code's binary carried `speaks=1` and reached no batch at all, and this agent
 * reported them to an operator as cards that had gone to the channel. Two joins would have said
 * otherwise, and nothing in the answer suggested the joins were needed.
 *
 * So the question is answered where it is asked. `reachedAReader` is the headline because it is
 * what was being guessed at, and the four paths to it are laid out underneath: the standing verdict
 * with every rule that vetoed it and where, the batches the event was folded into, the deliveries
 * those batches became, and the corroboration verdict that is otherwise only readable out of
 * `app_state` by story id.
 */
export type EventEvidence = {
  event: Event & { lifecycle: string | null };
  reachedAReader: boolean;
  /**
   * `speaks` as stored, named for what it means. Null is an event no batch has been built for yet,
   * which is a different thing from a veto and reads identically in the column.
   */
  standing: { speaks: boolean | null; suppressedBy: SuppressionRow[] };
  story: StoryRow | null;
  batches: BatchRow[];
  deliveries: DeliveryRow[];
  corroboration: ReturnType<typeof corroborationOfEvent>;
};

type SuppressionRow = { destination_id: string; batch_id: number; reason: string; detail: string; recorded_at: string };
type StoryRow = { id: number; title: string; vendor: string | null; confidence: string; current_status: string };
type BatchRow = { id: number; kind: string; digest: number; ready_at: string; sealed: number; signal: string | null };
type DeliveryRow = {
  id: number;
  destination_id: string;
  status: string;
  attempts: number;
  error: string | null;
  updated_at: string;
  /** Whether the event is named by the batch directly or arrived inside a digest. */
  via: "batch" | "digest";
};

export function eventEvidence(db: Database, id: number): EventEvidence | null {
  // `speaks` is a column of the table and not a field of `Event`: the type carries what a card is
  // rendered from, and this is a verdict about the row. Read here under its own name rather than
  // widened into `Event`, where the same spread that once broke narrowing on `signal` is waiting.
  const event = db.query<Event & { speaks: number | null }, [number]>("SELECT * FROM events WHERE id=?").get(id);
  if (!event) return null;
  const suppressedBy = db
    .query<SuppressionRow, [number]>(
      "SELECT destination_id,batch_id,reason,detail,recorded_at FROM suppressions WHERE event_id=? ORDER BY recorded_at",
    )
    .all(id);
  const story =
    db
      .query<StoryRow, [number]>(
        `SELECT s.id,s.title,s.vendor,s.confidence,s.current_status FROM stories s
         JOIN story_events se ON se.story_id=s.id WHERE se.event_id=?`,
      )
      .get(id) ?? null;
  const batches = db
    .query<BatchRow, [number]>(
      `SELECT b.id,b.kind,b.digest,b.ready_at,b.sealed,be.signal FROM batches b
       JOIN batch_events be ON be.batch_id=b.id WHERE be.event_id=? ORDER BY b.id`,
    )
    .all(id);
  // Both ways an event reaches a delivery: named by its own batch, or folded into a digest whose
  // rows are kept in `delivery_events`. Reading only the first undercounts exactly the messages a
  // reader is most likely to have actually seen.
  const deliveries = db
    .query<DeliveryRow, [number, number]>(
      `SELECT id,destination_id,status,attempts,error,updated_at,via FROM (
         SELECT d.id,d.destination_id,d.status,d.attempts,d.error,d.updated_at,'batch' AS via
           FROM deliveries d JOIN batch_events be ON be.batch_id=d.batch_id WHERE be.event_id=?
         UNION
         SELECT d.id,d.destination_id,d.status,d.attempts,d.error,d.updated_at,'digest' AS via
           FROM deliveries d JOIN delivery_events de ON de.delivery_id=d.id WHERE de.event_id=?
       ) ORDER BY id`,
    )
    .all(id, id);
  return {
    event: { ...event, lifecycle: lifecycleState(event) },
    // Sent is the only status that means a reader has it. A delivery still being retried has not
    // reached anybody yet, and a failed one never will.
    reachedAReader: deliveries.some((delivery) => delivery.status === "sent"),
    standing: { speaks: event.speaks === null ? null : Boolean(event.speaks), suppressedBy },
    story,
    batches,
    deliveries,
    corroboration: corroborationOfEvent(db, id),
  };
}
