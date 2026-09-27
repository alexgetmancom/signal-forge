import { readableName } from "../events/naming.js";
import { modelSubject } from "../events/variants.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

/**
 * A week reports what went away in it, not what is scheduled to.
 *
 * The horizon used to be a quarter ahead, which put "GPT-4o (9 Dec 2026)" under a heading about
 * 20-27 September -- a deadline two and a half months out, in the one message a reader opens to
 * find out what changed. Every dated deadline already reaches them as its own card at thirty, seven
 * and one day out, so the quarter ahead was being said twice and the week itself never at all.
 */

/** What the maker said is going away, from a lifecycle table and from its own changelog sentence. */
export function periodRetirements(
  reading: PeriodReading,
  arrivedThisPeriod: Set<string>,
): { retirements: RecapContext["retirements"]; retirementNotes: string[] } {
  const { classified, period, from, to } = reading;
  // What the maker said is going away this week, with the date it goes when the notice gives one.
  // A retirement card came off the public wire after five of them; one line a week is the size
  // of it for a reader who does not run the model.
  // A row appearing in a lifecycle table is not a retirement. Google publishes a model and lists
  // it in the same table the day it ships: `gemini-3.8-live` arrived and was said to be retiring in
  // one message on 2026-09-20. A notice with no date is a row, not news, so only a dated one counts
  // -- and a name this same week reports as arrived never appears under "Retiring".
  const retirements = classified
    .filter(
      ({ event, signal }) => (signal === "retirement" || event.stream === "deprecations") && event.stream !== "news",
    )
    .map(({ event }) => {
      const record = recordOf(event);
      const date = [record?.shutdown, record?.retirement, record?.deprecated].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      const name = nameOf(event);
      return { name: readableName(name), subject: modelSubject(name), date: date ?? null };
    })
    .filter((retirement) => retirement.date !== null && !arrivedThisPeriod.has(retirement.subject))
    .filter((retirement, index, all) => all.findIndex((other) => other.name === retirement.name) === index)
    // Soonest first, and nothing whose date has already passed: a table re-read this week listed
    // models retired in December 2025 above one going in October, and neither is next.
    // "Not sooner than September 1, 2027" and "To be announced" are dates a maker hedged; the words
    // in front of them are dropped so the day itself can be read, and a line nothing can be read
    // from is kept rather than guessed at.
    .map((retirement) => ({
      ...retirement,
      at: Date.parse(String(retirement.date).replace(/^(?:not sooner than|to be announced|on)\s+/i, "")),
    }))
    // The date has to fall inside the week being reported. "Claude Mythos 5 (9 Jun 2027)" is
    // twenty-one months away and changes nothing a reader does this week; a line nothing can be
    // read from at all is not worth the ink either, so both go.
    .filter(
      (retirement) =>
        Number.isFinite(retirement.at) && retirement.at >= Date.parse(from) && retirement.at < Date.parse(to),
    )
    .sort((one, other) => one.at - other.at)
    .map(({ name, date }) => ({ name, date }))
    .slice(0, 4);
  // A changelog headline is a sentence, not a model, and comma-joining several into one "Retiring:"
  // list read as a list of models: "Changes to automatic switching to thinking in ChatGPT" was
  // never a retirement at all. Each announcement gets its own line, and only when its own words say
  // something is going away.
  const WHEN_WORDS =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
  const RETIRING_WORDS =
    /\bretir\w*|\bdeprecat\w*|\bsunsets?\b|\bshut(?:ting|s)? down|\bdiscontinu\w*|\bremov(?:ed|al|ing)\b/i;
  const retirementNotes =
    period !== "week"
      ? []
      : classified
          .filter(({ event, signal }) => signal === "retirement" && event.stream === "news" && event.kind === "new")
          .map(({ event }) => readableName(nameOf(event)).replace(/^[^:]{1,40}:\s+/, ""))
          .filter((note) => RETIRING_WORDS.test(note))
          // A sentence with no date in it is an intention, not a deadline: "Planned custom GPT
          // retirement and migration to plugins" tells a reader nothing to do and nothing to wait
          // for. The two lines beside the table have to earn the space the table does.
          .filter((note) => WHEN_WORDS.test(note))
          .filter((note, index, all) => all.indexOf(note) === index)
          .slice(0, 2);
  return { retirements: period === "week" ? retirements : [], retirementNotes };
}
