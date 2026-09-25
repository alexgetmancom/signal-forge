import type { z } from "zod";
import { SourceError } from "../failure.js";

/**
 * Validate a list one entry at a time, so a failure can say which field of how many entries broke.
 *
 * `z.array(entry).parse(raw)` is all or nothing, and its error names the first offender and stops.
 * Filed as "response did not match the schema (ZodError)" that is the least useful sentence a report
 * can carry: `arena` failed 30 of 178 attempts over three days on 2026-09-25 with exactly that line,
 * and because the body of a failed parse is never stored there was nothing to look at afterwards.
 *
 * Entry-wise validation answers the question the sentence raised. It still refuses the answer -- a
 * catalogue that quietly returns fewer models than it has is how a removal gets invented, and
 * `suspiciousShrink` exists because that already happened -- but it refuses it by name: how many
 * entries of how many, and which fields. Deciding to loosen a field is then a decision somebody can
 * make from the report instead of from a guess.
 */
export function parseEachEntry<T>(schema: z.ZodType<T>, raw: unknown, label: string): T[] {
  if (!Array.isArray(raw)) throw new SourceError("schema", `${label} is not a list of entries`);
  const values: T[] = [];
  /** Field path to the number of entries that failed on it. Paths come from the schema, not the data. */
  const fields = new Map<string, number>();
  let rejected = 0;
  for (const entry of raw) {
    const result = schema.safeParse(entry);
    if (result.success) {
      values.push(result.data);
      continue;
    }
    rejected++;
    for (const issue of result.error.issues) {
      const path = issue.path.map((element) => (typeof element === "number" ? "#" : String(element))).join(".") || ".";
      fields.set(path, (fields.get(path) ?? 0) + 1);
    }
  }
  if (!rejected) {
    if (!values.length) throw new SourceError("empty", `${label} returned no entries`, { evidence: { entries: 0 } });
    return values;
  }
  const named = [...fields.entries()].sort((left, right) => right[1] - left[1]);
  const evidence = {
    entries: raw.length,
    accepted: values.length,
    rejected,
    fields: Object.fromEntries(named),
  };
  throw new SourceError(
    "schema",
    `${label}: ${rejected} of ${raw.length} entries did not match the schema (${named
      .slice(0, 4)
      .map(([path, count]) => `${path} in ${count}`)
      .join(", ")})`,
    { evidence },
  );
}
