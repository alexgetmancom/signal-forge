/**
 * What a probe remembers between polls, and the one question that memory is kept for.
 *
 * Its own module because the answer is read on the delivery path, where a collector may not be
 * imported: the rule below decides whether a sighting is held back from a reader, and
 * `src/sources/probes.ts` is a module that makes HTTP requests. The writer and the reader share one
 * definition of the stored shape, which is the whole reason this is not two parsers.
 */
import type { Database } from "bun:sqlite";
import { readLatestSnapshot } from "../storage/snapshots.js";

/**
 * What a previous poll asked, what it was told, and which shape the question came from.
 *
 * `family` is carried because the slug alone cannot be read back into the shape that produced it:
 * `opus-6` is a question about the Opus line only to the code that generated it, and the rule that
 * holds a shape's first read needs the same mapping a month later, from the snapshot alone.
 */
export type Asked = Record<string, { status: number; at: string; family?: string }>;

/**
 * The stored snapshot of a probe: every address it has asked lately, and when each shape was first
 * asked about at all.
 *
 * `shapes` is the half the channel depends on. A shape added to a probe asks its first questions
 * about a line the maker has been shipping for months, so the first poll answers 200 for the whole
 * back catalogue at once: `fable` and `mythos` were added to the Anthropic probe on 2026-09-30 and
 * twenty-four names were recorded in one second and sent out as findings, where a reader left a
 * thumb down. The dates live here rather than in a record body, so nothing a collector stores
 * changes and no later poll has to keep sending a field to avoid announcing its absence.
 */
export type ProbeMemory = { asked: Asked; shapes: Record<string, string> };

/**
 * The memory a previous poll left, in either of the two forms it has been written in.
 *
 * A snapshot stored before `shapes` existed is a flat map of addresses, and it is read as a probe
 * whose shapes were all first asked about long ago -- which is what it says. Seeded with `now`
 * instead, the poll after this ships would read every shape as new and hold a month of genuine
 * sightings; seeded at the epoch, the only shapes the rule can hold are the ones added after it.
 */
export function probeMemory(db: Database, source: string): ProbeMemory {
  const stored = readLatestSnapshot(db, source);
  const empty: ProbeMemory = { asked: {}, shapes: {} };
  if (!stored) return empty;
  try {
    const body: unknown = JSON.parse(stored);
    if (!body || typeof body !== "object") return empty;
    const held = body as Partial<ProbeMemory> & Asked;
    if (held.asked && typeof held.asked === "object")
      return { asked: held.asked, shapes: held.shapes && typeof held.shapes === "object" ? held.shapes : {} };
    const asked = body as Asked;
    const shapes = Object.fromEntries(
      [...new Set(Object.values(asked).map((answer) => answer.family))]
        .filter((family): family is string => typeof family === "string")
        .map((family) => [family, EPOCH]),
    );
    return { asked, shapes };
  } catch {
    return empty;
  }
}

/** The date a shape asked about before this poll's memory existed is read as having been first asked. */
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * How long after a shape is first asked about its answers are read as a back catalogue.
 *
 * A page that already existed answers 200 on the first poll that knows to ask, so everything the
 * expansion finds is found inside one poll of it. Longer than a poll so a slow or batched run is
 * still covered, and short enough that a model the maker ships the same afternoon is news.
 */
export const SHAPE_BACKFILL_MS = 3_600_000;

/**
 * Whether this sighting is part of the first read of a shape the probe had never asked about.
 *
 * No list of probes is consulted: a snapshot that dates its shapes is one a probe wrote, and any
 * other source answers false because it has no such dates. Read from the probe's own memory rather
 * than from the event: the sighting is an ordinary record,
 * and what makes it an import of history is when its shape entered the question, which only the
 * snapshot knows. A slug the memory has forgotten -- it keeps thirty days -- answers false, which
 * is the right answer, because a shape first asked about more than thirty days ago is not new.
 */
export function isTheFirstReadOfAShape(db: Database, source: string, slug: string, detectedAt: string): boolean {
  const { asked, shapes } = probeMemory(db, source);
  const family = asked[slug]?.family;
  if (!family) return false;
  const firstAsked = Date.parse(shapes[family] ?? "");
  const detected = Date.parse(detectedAt);
  if (!Number.isFinite(firstAsked) || !Number.isFinite(detected)) return false;
  return detected >= firstAsked && detected - firstAsked < SHAPE_BACKFILL_MS;
}
