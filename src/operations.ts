import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { sourceJobs } from "./poller.js";

export function operations(db: Database, config: AppConfig) {
  return {
    status: {
      description: "Source health, configured destinations and delivery queue counts.",
      schema: z.object({}),
      handler: () => ({
        sources: sourceJobs(db, config).map((job) => ({
          id: job.id,
          intervalSeconds: job.interval,
          ...(db
            .query<{ last_success: string | null; last_error: string | null; checked_at: string | null }, [string]>(
              "SELECT last_success,last_error,checked_at FROM sources WHERE id=?",
            )
            .get(job.id) ?? {}),
        })),
        unavailable: [
          ...(!config.OPENAI_API_KEY ? ["openai: API key missing"] : []),
          ...(!config.ANTHROPIC_API_KEY ? ["anthropic: API key missing"] : []),
          ...(!config.GEMINI_API_KEY ? ["gemini: API key missing"] : []),
        ],
        destinations: config.destinations,
        digestEvents: db
          .query("SELECT COUNT(*) AS count FROM batch_events e JOIN batches b ON b.id=e.batch_id WHERE b.sealed=0")
          .get(),
        deliveries: db.query("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status").all(),
      }),
    },
    events: {
      description: "Recent detected changes, including before and after evidence.",
      schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      handler: (input: { limit: number }) =>
        db
          .query("SELECT id,source,stream,entity_id,kind,detected_at FROM events ORDER BY id DESC LIMIT ?")
          .all(input.limit),
    },
    event: {
      description: "Full before/after evidence for one event.",
      schema: z.object({ id: z.number().int().positive() }),
      handler: (input: { id: number }) => db.query("SELECT * FROM events WHERE id=?").get(input.id),
    },
    deliveries: {
      description: "Recent delivery outcomes. Ambiguous sends require checking the destination.",
      schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      handler: (input: { limit: number }) =>
        db
          .query(
            "SELECT id,batch_id,destination_id,status,attempts,external_id,error FROM deliveries ORDER BY id DESC LIMIT ?",
          )
          .all(input.limit),
    },
  };
}
