import { breakoutOf } from "../events/breakouts.js";
import { readableName } from "../events/naming.js";
import { recordFor } from "../events/record.js";
import { isUnfollowedMakerAtAReseller } from "../events/resellers.js";
import { oneLinePerModel } from "../events/variants.js";
import { vendorOf } from "../events/vendors.js";
import { notableCommits } from "../insights.js";
import { sourceLabel } from "../sources/labels.js";
import { nameOf, type PeriodReading } from "./reading.js";
import type { RecapContext } from "./schema.js";

/** Small companies' models at resellers, and the commits worth a sentence. */
export function periodSightings(reading: PeriodReading): {
  resellerArrivals: RecapContext["resellerArrivals"];
  codeNotes: RecapContext["codeNotes"];
} {
  const { db, classified, period, from, to } = reading;
  // Small companies' models at resellers: a line each, unless one took off and was a card already.
  const resellerArrivals =
    period !== "day"
      ? []
      : classified
          .filter(({ event }) => isUnfollowedMakerAtAReseller(event) && !breakoutOf(db, event.id))
          // A row appearing at a reseller says the reseller started serving it, not that it exists.
          // Hugging Face's router listed Granite 4.2 30B on 2026-09-20 and GLM 4.5 twice; the
          // registry dates them August and July, and "New at huggingface-router" was a year late on
          // one of them. When the catalogue gives the model's own date, it has to be inside the day.
          .filter(({ event }) => {
            const created = Date.parse(String(recordFor(event)?.created ?? ""));
            return !Number.isFinite(created) || created >= Date.parse(from);
          })
          .map(({ event }) => {
            const record = recordFor(event);
            const maker = vendorOf(event, record);
            return {
              // The name as the catalogue wrote it. `readableName` is applied after the grouping
              // below and not before it: it turns `MAI-Image-2.6-2026-07-31` into
              // `MAI Image 2.6 2026 07 31`, and a dated snapshot with its hyphens spaced out is a
              // snapshot no rule here can recognise any more.
              name: nameOf(event),
              reseller: sourceLabel(event.source).split(" · ")[0] ?? event.source,
              // The catalogue writes itself into `maker` often enough that its own name is no
              // answer: "Toast 1 · mixedbread" is worth a line, "Granite · Hugging Face" is not.
              maker: maker !== "Unknown" ? maker : String(record?.maker ?? "").replace(/^hugging ?face$/i, ""),
            };
          })
          .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
  // Collapsed after the day is read rather than while it is: eight lines was eight rows, and a
  // catalogue restating one model filled the digest before a second model got a line.
  const collapsed = oneLinePerModel(resellerArrivals)
    .slice(0, 8)
    .map((entry) => ({ ...entry, name: readableName(entry.name) }));
  const codeNotes =
    period !== "day"
      ? []
      : notableCommits(db, from, to).flatMap(({ event }) => {
          const text = db
            .query<{ text: string }, [number]>("SELECT text FROM summaries WHERE event_id=?")
            .get(event.id)?.text;
          const repo = event.source.split(":")[1]?.split("/").at(-1) ?? event.source;
          return text ? [{ repo: repo.charAt(0).toUpperCase() + repo.slice(1), text }] : [];
        });
  return { resellerArrivals: collapsed, codeNotes };
}
