/**
 * The date a catalogue puts on the model itself, as opposed to the date we happened to read it.
 *
 * These two are the whole difference between "nobody has heard this yet" and "we are three weeks
 * late", and until this module existed the deployment could not tell them apart outside the one
 * veto in `worth.ts` that read the field at event time and threw it away. Gemini 3.8 Flash was
 * shipped on 2 September and first appeared in our records on the 22nd; GLM 5.2 Fast was out in
 * June. Both read as discoveries, and the misses report headlined them as the week's worst.
 *
 * OpenRouter and Hugging Face carry the date a model was created, and several catalogues copy it.
 * Reading it is what dates a release without a lookup, so it is read once, here, and the callers
 * that used to each have their own copy of the field list now share this one.
 */

/** The field names catalogues write a model's own date under. */
export const CREATED_FIELDS = ["created", "createdAt", "created_at", "releaseDate", "release_date"] as const;

/** Before this, a date is a placeholder rather than a release: catalogues write `created: 1`. */
const EARLIEST_RELEASE = Date.parse("2015-01-01T00:00:00.000Z");

/**
 * The last instant a `Date` can hold. A catalogue field beyond it is finite and later than 2015 and
 * still not a date: `toISOString` throws on it, and the story row is written from this value, so one
 * such field in one record failed the collection that carried it on every poll. The bound is the
 * language's own rather than a judgement about what a plausible release is, so no value that was
 * read before is read differently now.
 */
const LATEST_INSTANT = 8.64e15;

/**
 * One field's value read as an instant, or null when it is not a date a model could have.
 *
 * A catalogue writes an epoch in seconds on OpenRouter and in milliseconds elsewhere, and the two
 * are told apart by magnitude rather than by source: a seconds epoch for any date this side of 2001
 * is below 1e11 and a milliseconds one is above it.
 */
function releaseDateOf(value: unknown): number | null {
  const at =
    typeof value === "number"
      ? value * (value > 1e11 ? 1 : 1000)
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) && at >= EARLIEST_RELEASE && at <= LATEST_INSTANT ? at : null;
}

/** The earliest date a record claims for the model it describes, across every spelling of the field. */
export function recordReleaseDate(fields: Record<string, unknown> | null | undefined): number | null {
  let earliest: number | null = null;
  for (const field of CREATED_FIELDS) {
    const at = releaseDateOf(fields?.[field]);
    if (at !== null && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/** True when a record dates the model itself, and that date is older than the cutoff. */
export function createdBefore(fields: Record<string, unknown> | null | undefined, cutoff: number): boolean {
  const at = recordReleaseDate(fields);
  return at !== null && at < cutoff;
}

/**
 * How late a reading has to be before it is history rather than news.
 *
 * One month, and one constant, because this was three: `LONG_PUBLISHED_MS` in weightsWorth.ts for a
 * router, `ALREADY_OUT_MS` in retoldWorth.ts for a catalogue, both thirty days and both answering
 * the same question of different sources.
 */
export const LONG_AGO_MS = 30 * 24 * 3_600_000;

/**
 * The streams where a record is a model being listed, which is the only place this question means
 * what it says.
 *
 * Deliberately not every stream. A deprecation notice carries the model's own creation date too,
 * and a two-year-old model being retired is exactly the news a reader wants; a rule that read
 * `created` wherever it found it would hold the retirements and call it tidiness.
 */
const LISTING_STREAMS = new Set(["api-models", "openrouter", "weights"]);

/**
 * A model arriving here that its own publisher dated more than a month ago.
 *
 * Asked of every source that lists models, which is the half that was missing. The question was
 * written twice -- once for Hugging Face's router, once for a catalogue importing a back
 * catalogue -- and each copy was scoped to the surfaces that had embarrassed us so far, so the
 * gap between them was where the next surface landed. `huggingface:microsoft` fell in it on
 * 2026-10-04: a listing sorted by `lastModified` was added, fifty repositories per organisation
 * were read for the first time, and 25 of them became cards. `microsoft/phi-4` was published on
 * 2024-12-11 and announced here as new.
 *
 * The date is the publisher's own, so neither the surface that found the model nor the day this
 * deployment started asking enters the answer -- which is what makes one rule enough for sources
 * that do not exist yet. A sighting is the earliest word on a model; a month after publication
 * nothing here is the earliest word on anything.
 *
 * Never asked of a launch, which is the one case where the publisher's own date argues against the
 * publisher. A provider's API writes `created` when the model was built, not when it became
 * callable: `glm-5.3-flashx` appeared in zai's own catalogue on 2026-09-18 dated 2026-08-13, and
 * that gap is the model becoming available, which is the news itself. A sighting is somebody else
 * noticing a model; a launch is its maker saying it is out, and nothing in the record outranks that.
 */
export function wasPublishedLongBeforeWeReadIt(
  fields: Record<string, unknown> | null | undefined,
  stream: string,
  kind: string,
  detectedAt: string,
  signal: string | null,
): boolean {
  if (kind !== "new" || signal === "launch" || !LISTING_STREAMS.has(stream)) return false;
  const detected = Date.parse(detectedAt);
  return Number.isFinite(detected) && createdBefore(fields, detected - LONG_AGO_MS);
}
