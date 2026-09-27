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
const CREATED_FIELDS = ["created", "createdAt", "created_at", "releaseDate", "release_date"] as const;

/** Before this, a date is a placeholder rather than a release: catalogues write `created: 1`. */
const EARLIEST_RELEASE = Date.parse("2015-01-01T00:00:00.000Z");

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
  return Number.isFinite(at) && at >= EARLIEST_RELEASE ? at : null;
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
