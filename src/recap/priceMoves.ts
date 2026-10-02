import { readableName } from "../events/naming.js";
import { isScheduledPricingRotation } from "../events/oscillation.js";
import { recordFor } from "../events/record.js";
import { priceMoveRatio, pricePair, significantPriceChange } from "../events/render/common.js";
import type { Event, RecordData } from "../events/types.js";
import { isModelVariant, modelSubject } from "../events/variants.js";
import { subjectKey } from "../events/witness.js";
import { nameOf, type PeriodReading } from "./reading.js";
import type { RecapContext } from "./schema.js";

/**
 * What a reader is actually billed.
 *
 * A catalogue row prices half a dozen things -- prompt, completion, cached reads, images, web
 * search -- and the steepest of them is usually the smallest number. IBM's Granite 4.2 8B dropped
 * its cached-read rate by seventy percent in the same edit that made output sixty-seven percent
 * dearer, and "down 70%" was true of a field almost nobody pays and false of the week.
 */
const BILLED_ELSEWHERE = /cache|image|request|search|audio|video|discount|internal/i;
/** How long after a model appears a rise still reads as the end of its launch promotion. */
const LAUNCH_PROMOTION_MS = 90 * 24 * 3_600_000;

type PriceMove = {
  name: string;
  percent: number;
  ratio: number;
  cheaper: boolean;
  reportable: boolean;
  discountEnded: boolean;
  from: number;
  to: number;
  field: string;
};

/**
 * What a reader is being quoted for. A catalogue prices input and output separately and they move
 * by different amounts in the same edit: Qwen3.8 27B's input doubled on 2026-09-20 while its output
 * rose a sixth, and a line that says neither which it is leaves the reader to guess the expensive one.
 */
function priceField(key: string): string {
  if (/completion|output/i.test(key)) return "output";
  if (/prompt|input/i.test(key)) return "input";
  return key.replace(/_/g, " ");
}

function pricing(json: string | null): Record<string, unknown> {
  const record = json ? (JSON.parse(json) as RecordData) : null;
  return record?.pricing && typeof record.pricing === "object" ? (record.pricing as Record<string, unknown>) : {};
}

/**
 * Where a price started the week and where it ended it, one entry per field a reader pays.
 *
 * `ratio` ranks moves against each other, as it always has. `percent` is what a reader is told, and
 * it is relative to the old price, so a rise reads as the multiple it actually is. Reading the
 * first `before` against the last `after` is what makes a price that went up and came back down
 * again produce no line at all.
 */
function netPriceMoves(
  first: Event,
  last: Event,
): { percent: number; ratio: number; cheaper: boolean; from: number; to: number; field: string }[] {
  const from = pricing(first.before_json);
  const to = pricing(last.after_json);
  const moves: { percent: number; ratio: number; cheaper: boolean; from: number; to: number; field: string }[] = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (BILLED_ELSEWHERE.test(key)) continue;
    // What a card would have required of the same move. Every OpenRouter price is held back for
    // this recap whatever its size, so without the same floor here the day reported a catalogue
    // rounding its whole table: GLM 5.3 moved 1.54% on every field at once on 2026-09-20, which is
    // an exchange rate, and "down 2%" was the first line a reader saw that morning.
    if (!significantPriceChange(from[key], to[key], last.source)) continue;
    const ratio = priceMoveRatio(from[key], to[key], last.source);
    const pair = pricePair(from[key], to[key], last.source);
    if (ratio === null || ratio === 0 || !pair || pair.from === 0) continue;
    moves.push({
      percent: Math.abs(pair.to - pair.from) / pair.from,
      ratio,
      cheaper: pair.to < pair.from,
      from: pair.from,
      to: pair.to,
      field: priceField(key),
    });
  }
  return moves;
}

/** True when the catalogue says this row appeared recently enough for a promotion to be ending. */
function recentlyListed(record: RecordData | null, to: string): boolean {
  const created = typeof record?.created === "string" ? Date.parse(record.created) : Number.NaN;
  return Number.isFinite(created) && Date.parse(to) - created <= LAUNCH_PROMOTION_MS;
}

/** One model, one price line: the period's net move, told only for a model something else knows. */
export function periodPriceMoves(reading: PeriodReading): RecapContext["priceMoves"] {
  const { classified, carded, witnessed, usage, to } = reading;
  // One model, one price line, and the line is the week's net move rather than its steepest step.
  //
  // A catalogue lists the same model under several rows and edits each of them more than once. On
  // 8 September two rows of Inception's Mercury 2.5 moved in opposite directions an hour apart --
  // the preview row up five times as its launch discount expired, the standard row down eighty
  // percent onto that same discount -- and the flattering half sorted highest. A subject whose rows
  // or fields disagree says nothing at all: one of them is the week's news and nothing in the data
  // says which.
  const byRow = new Map<string, { event: Event; name: string }[]>();
  for (const { event, signal } of classified) {
    if (signal !== "change") continue;
    // A base rate rotating onto a tier the record itself publishes is not a move at all.
    if (isScheduledPricingRotation(event)) continue;
    const row = byRow.get(`${event.source}\u0000${event.entity_id}`) ?? [];
    row.push({ event, name: nameOf(event) });
    byRow.set(`${event.source}\u0000${event.entity_id}`, row);
  }
  const bySubjectMove = new Map<string, PriceMove[]>();
  for (const whole of byRow.values()) {
    // Only what came after the last card is untold. Skipping the whole row once any step was carded
    // dropped the step after it too, which is the step a held move never got a card for.
    const lastCarded = whole.map(({ event }) => carded.has(event.id)).lastIndexOf(true);
    const row = whole.slice(lastCarded + 1);
    const first = row[0]?.event;
    const last = row.at(-1)?.event;
    const name = row.at(-1)?.name ?? "";
    if (!first || !last) continue;
    // A price that went both ways inside the period is a catalogue routing between providers, not a
    // repricing. OpenRouter moved GLM 5.3 Flash 0.10 → 0.09 → 0.07 → 0.09 on 2026-09-16; dropping the
    // step back as oscillation left the step down standing, and the day was reported 30% cheaper
    // when it ended 10% cheaper. Neither figure is news, so the row says nothing.
    const directions = new Set(row.flatMap(({ event }) => netPriceMoves(event, event).map((move) => move.cheaper)));
    if (directions.size > 1) continue;
    const moves = netPriceMoves(first, last);
    // Input down and output up in the same edit is a repricing, not a cut; IBM's Granite was
    // reported seventy percent cheaper on a cached-read rate in the week its output got dearer.
    if (!moves.length || new Set(moves.map((move) => move.cheaper)).size !== 1) continue;
    const steepest = moves.reduce((best, move) => (move.ratio > best.ratio ? move : best));
    const subject = modelSubject(name);
    const held = bySubjectMove.get(subject) ?? [];
    // A tier carries no line of its own and is still evidence about the subject: Mercury's preview
    // row is where the expiring discount showed.
    held.push({
      name: readableName(name),
      ...steepest,
      reportable: !isModelVariant(name) && witnessed.has(subjectKey(name)),
      // A price that rises weeks after a model first appeared is almost always the launch
      // promotion ending rather than a decision to charge more, and saying so is the difference
      // between a fact and a scare.
      discountEnded: !steepest.cheaper && recentlyListed(recordFor(last), to),
    });
    bySubjectMove.set(subject, held);
  }
  const priceMoves = [...bySubjectMove.values()]
    .filter((moves) => new Set(moves.map((move) => move.cheaper)).size === 1)
    .flatMap((moves) => {
      const reportable = moves.filter((move) => move.reportable);
      return reportable.length ? [reportable.reduce((best, move) => (move.ratio > best.ratio ? move : best))] : [];
    })
    // A model people actually run first, and only then the size of the move.
    .sort((one, other) => {
      const mine = usage.get(subjectKey(one.name)) ?? Number.POSITIVE_INFINITY;
      const theirs = usage.get(subjectKey(other.name)) ?? Number.POSITIVE_INFINITY;
      return mine - theirs || other.ratio - one.ratio;
    })
    .slice(0, 3)
    .map(({ name, percent, cheaper, discountEnded, from: was, to: now, field }) => ({
      name,
      percent,
      cheaper,
      discountEnded,
      field,
      from: was,
      to: now,
    }));
  return priceMoves;
}
