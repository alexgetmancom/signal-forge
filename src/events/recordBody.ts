import type { RecordData } from "./types.js";

/**
 * A stored record body as an object, or null for anything that is not one.
 *
 * The service writes every body itself, so a body that does not parse, or parses to something that
 * is not an object, is damage rather than input: a `null`, an array and a number are all valid JSON
 * and all unreadable as a record. Every reader treats such a row as absent instead of failing a
 * whole report over it. This used to be written four ways -- one that threw on bad JSON, one that
 * handed an array back as a record, one private to witness.ts and about eighty inline casts -- and
 * `JSON.parse("null").name` is what took a report down.
 *
 * It lives apart from `record.ts` because it knows nothing about events: it is a string in and an
 * object out, which a collector or a model may read without being able to reach how an event is
 * read, let alone written (see the two rules in .dependency-cruiser.jsonc that name `record.ts`).
 *
 * The cast to `RecordData` is a promise about `id` and `name` that nothing here checks; the store
 * validates both before a record is ever written, which is where that promise is kept.
 */
export function parseRecord(body: string | null | undefined): RecordData | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RecordData) : null;
  } catch {
    return null;
  }
}
