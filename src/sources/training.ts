import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Xiaomi training its next models in public.
 *
 * mimo.xiaomi.com/rl streams the reinforcement-learning runs of `mimo-v2.6-pro` and `mimo-v2.6-flash`
 * from the trainer's logs, measured 2026-09-17 while neither model was in the MiMo API. A run appearing
 * names a model before any release, and a run ending is the step before one. Step counts, rewards and
 * cost move every few minutes and say nothing about arrival, so a record keeps only the run itself.
 */
const MIMO_RL = "https://mimo.xiaomi.com/rl";

const runsSchema = z.object({
  runs: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(1),
});

const statusSchema = z.object({
  run: z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    start: z.number().positive(),
    end: z.number().positive().nullable(),
    mode: z.string().min(1),
  }),
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export async function collectMimoTraining(request: Fetch = fetch): Promise<Collection> {
  const headers = { accept: "application/json" };
  const { runs } = runsSchema.parse(JSON.parse(await fetchText(`${MIMO_RL}/api/runs`, headers, request)));
  const statuses = await Promise.all(
    runs.map(async (run) =>
      statusSchema.parse(
        JSON.parse(await fetchText(`${MIMO_RL}/api/status?run=${encodeURIComponent(run.key)}`, headers, request)),
      ),
    ),
  );
  const records = statuses.map(({ run }) => ({
    id: run.label,
    name: run.label,
    maker: "Xiaomi",
    url: `${MIMO_RL}/`,
    mode: run.mode,
    started: iso(run.start),
    ...(run.end ? { ended: iso(run.end) } : {}),
  }));
  return { source: "mimo-training", stream: "training", url: `${MIMO_RL}/`, raw: records, records };
}
