import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import { readableName } from "./events/naming.js";
import { isOscillating, isScheduledPricingRotation } from "./events/oscillation.js";
import { renamedEvents } from "./events/rename.js";
import { priceMoveRatio, pricePair } from "./events/render/common.js";
import { signalClass } from "./events/signals.js";
import type { Event, RecordData } from "./events/types.js";
import {
  arrivalWeight,
  isBesideTheRelease,
  isModelVariant,
  isRepublished,
  isTrainingArtefact,
  modelSubject,
} from "./events/variants.js";
import { vendorOf, vendorOfName } from "./events/vendors.js";
import { subjectKey, witnessedSubjects } from "./events/witness.js";

/**
 * A week, summarised once, in the channel that otherwise only says what is happening now.
 *
 * The public wire is built for the moment a thing happens, which is exactly what a reader who was
 * away cannot use: scrolling back through a week of cards is not a summary of it. One message says
 * what arrived, what moved furthest and what the scouts saw before anyone else, and it is worth the
 * most in the quiet weeks -- the ones where a reader would otherwise wonder why they follow this.
 *
 * It is a batch like any other, so it is rendered, delivered and retried by the machinery that
 * already exists, and its identity is the period it covers: one row per week per source, enforced
 * by an index rather than remembered by this function.
 */
const RECAP_SOURCE = "weekly-recap";
const WEEK_MS = 7 * 24 * 3_600_000;
/** Where a thing shows up before anyone announces it. */
const EARLY_STREAMS = new Set(["arena", "pages"]);
/** Makers named in the recap itself; the rest are counted. */
const ARRIVAL_GROUPS = 6;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const weeklyRecapContextSchema = z.object({
  from: z.string(),
  to: z.string(),
  arrivals: z.array(z.object({ vendor: z.string(), names: z.array(z.string()) })),
  arrivalCount: z.number(),
  priceMoves: z.array(
    z.object({
      name: z.string(),
      percent: z.number(),
      cheaper: z.boolean(),
      // Absent in the recaps already stored before this was told apart from a decision to charge more.
      discountEnded: z.boolean().default(false),
    }),
  ),
  codenameCount: z.number(),
  bestLead: z.object({ name: z.string(), hours: z.number() }).nullable(),
});
export type WeeklyRecapContext = z.infer<typeof weeklyRecapContextSchema>;

/**
 * The end of the most recent complete week, as an instant.
 *
 * Sunday evening UTC: late enough that a week's last day is over in the Americas, early enough that
 * Asia reads it on Monday morning rather than a day later.
 */
export function lastRecapPeriod(now: number): string {
  const end = new Date(now);
  end.setUTCHours(18, 0, 0, 0);
  while (end.getUTCDay() !== 0 || end.getTime() > now) end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString();
}

function recordOf(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

function nameOf(event: Event): string {
  return String(recordOf(event)?.name ?? event.entity_id);
}

/**
 * Is this arrival a model, or another way of listing one?
 *
 * A batch tier, a free tier, a `latest` alias, a dated snapshot and somebody else's quantisation
 * are all real records and none of them is a release. Counting them is how the first recap reported
 * thirty-seven models in a week that had nine, and led with a batch tier of a model from July.
 */
function isRealArrival(event: Event, renamed: Set<number>): boolean {
  const record = recordOf(event);
  const name = String(record?.name ?? event.entity_id);
  if (renamed.has(event.id)) return false;
  // Only a registry says what an artefact is; a catalogue row is a model by construction.
  if (event.stream === "weights" && isBesideTheRelease(record)) return false;
  return !isModelVariant(name) && !isTrainingArtefact(name) && !isRepublished(event, record);
}

/**
 * Who a reader would say published this.
 *
 * The maker table answers for anything it recognises. Everything else names itself in the shape of
 * its own handle -- `Sakana: Fugu Max` from a catalogue, `google/gnm-v3` from a registry -- and
 * reading that is better than filing a real launch under "Other" because the maker is new.
 */
function arrivalVendor(event: Event, record: RecordData | null, name: string): string {
  const known = vendorOf(event, record);
  if (known !== "Unknown") return known;
  const labelled = /^([^:]{2,30}):\s/.exec(name);
  if (labelled?.[1]) return labelled[1];
  const id = String(record?.id ?? event.entity_id);
  const namespace = id.includes("/") ? (id.split("/")[0] ?? "") : "";
  return namespace || "Other";
}

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
};

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
function netPriceMoves(first: Event, last: Event): { percent: number; ratio: number; cheaper: boolean }[] {
  const from = pricing(first.before_json);
  const to = pricing(last.after_json);
  const moves: { percent: number; ratio: number; cheaper: boolean }[] = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (BILLED_ELSEWHERE.test(key)) continue;
    const ratio = priceMoveRatio(from[key], to[key], last.source);
    const pair = pricePair(from[key], to[key], last.source);
    if (ratio === null || ratio === 0 || !pair || pair.from === 0) continue;
    moves.push({ percent: Math.abs(pair.to - pair.from) / pair.from, ratio, cheaper: pair.to < pair.from });
  }
  return moves;
}

/** True when the catalogue says this row appeared recently enough for a promotion to be ending. */
function recentlyListed(record: RecordData | null, to: string): boolean {
  const created = typeof record?.created === "string" ? Date.parse(record.created) : Number.NaN;
  return Number.isFinite(created) && Date.parse(to) - created <= LAUNCH_PROMOTION_MS;
}

export function weeklyRecapContext(db: Database, to: string): WeeklyRecapContext {
  const from = new Date(Date.parse(to) - WEEK_MS).toISOString();
  const events = db
    .query<Event, [string, string]>("SELECT * FROM events WHERE detected_at>=? AND detected_at<? ORDER BY id")
    .all(from, to);
  const classified = events.map((event) => ({ event, signal: signalClass(event) }));
  const renamed = renamedEvents(db, events);
  const witnessed = witnessedSubjects(db);
  // One model however many collectors saw it, and the maker's own word ahead of a reseller's.
  const bySubject = new Map<string, { name: string; vendor: string; weight: number }>();
  for (const { event, signal } of classified) {
    if (signal !== "launch" || event.kind !== "new" || !isRealArrival(event, renamed)) continue;
    const record = recordOf(event);
    const name = nameOf(event);
    const subject = modelSubject(name);
    const weight = arrivalWeight(event);
    const held = bySubject.get(subject);
    if (!held || weight > held.weight)
      bySubject.set(subject, { name, vendor: arrivalVendor(event, record, name), weight });
  }
  // Weight first, then a maker a reader has heard of: a research artefact published as weights
  // outranks a catalogue row on paper and is not what the week was about.
  const ranked = [...bySubject.values()].sort(
    (one, other) =>
      other.weight - one.weight ||
      Number(vendorOfName(other.name) !== "Unknown") - Number(vendorOfName(one.name) !== "Unknown"),
  );
  // Grouped by maker, because that is the shape of the question a reader is asking. Eight names in
  // a row says a week happened; "OpenAI three, DeepSeek one" says what happened in it.
  const byVendor = new Map<string, string[]>();
  for (const arrival of ranked) {
    const names = byVendor.get(arrival.vendor) ?? [];
    // The maker's name is already the heading; repeating it inside every entry is noise.
    names.push(readableName(arrival.name).replace(new RegExp(`^${escapeForPattern(arrival.vendor)}:\\s*`, "i"), ""));
    byVendor.set(arrival.vendor, names);
  }
  const arrivals = [...byVendor.entries()].map(([vendor, names]) => ({ vendor, names }));
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
    // The rules a card already lives by. A base rate rotating onto a tier the record itself
    // publishes, or a level dithering back to where it was, is not a week's news either.
    if (isScheduledPricingRotation(event) || isOscillating(db, event, Date.parse(to))) continue;
    const row = byRow.get(`${event.source}\u0000${event.entity_id}`) ?? [];
    row.push({ event, name: nameOf(event) });
    byRow.set(`${event.source}\u0000${event.entity_id}`, row);
  }
  const bySubjectMove = new Map<string, PriceMove[]>();
  for (const row of byRow.values()) {
    const first = row[0]?.event;
    const last = row.at(-1)?.event;
    const name = row.at(-1)?.name ?? "";
    if (!first || !last) continue;
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
      discountEnded: !steepest.cheaper && recentlyListed(recordOf(last), to),
    });
    bySubjectMove.set(subject, held);
  }
  const priceMoves = [...bySubjectMove.values()]
    .filter((moves) => new Set(moves.map((move) => move.cheaper)).size === 1)
    .flatMap((moves) => {
      const reportable = moves.filter((move) => move.reportable);
      return reportable.length ? [reportable.reduce((best, move) => (move.ratio > best.ratio ? move : best))] : [];
    })
    .sort((one, other) => other.ratio - one.ratio)
    .slice(0, 3)
    .map(({ name, percent, cheaper, discountEnded }) => ({ name, percent, cheaper, discountEnded }));
  return weeklyRecapContextSchema.parse({
    from,
    to,
    arrivals: arrivals.slice(0, ARRIVAL_GROUPS),
    arrivalCount: ranked.length,
    priceMoves,
    // Distinct subjects, not events: the arena and the leaderboards are re-read all week, and
    // counting every observation turns "the scouts saw ten things early" into five figures.
    // What the scouts actually saw early: something unannounced showing up where it should not be
    // yet. A model taking a place on one more scoreboard is a `codename` by class and is not that.
    codenameCount: new Set(
      classified
        .filter(
          ({ event, signal }) =>
            signal === "codename" && EARLY_STREAMS.has(event.stream) && !event.source.startsWith("discovery:"),
        )
        .map(({ event }) => modelSubject(nameOf(event))),
    ).size,
    bestLead: null,
  });
}

/**
 * Queue the recap for the week that has just ended, once.
 *
 * It goes to the destinations that carry launches, which is the wire a reader follows for what they
 * can use: the invited room sees every one of these events as it happens and does not need the
 * week read back to it.
 */
export function scheduleWeeklyRecap(db: Database, config: AppConfig, now = Date.now()): boolean {
  const readyAt = lastRecapPeriod(now);
  const targets = (config.destinations as Destination[]).filter((destination) =>
    destination.signals.includes("launch"),
  );
  if (!targets.length) return false;
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM batches WHERE kind='weekly_recap' AND source=? AND ready_at=?",
    )
    .get(RECAP_SOURCE, readyAt);
  if (existing) return false;
  const context = weeklyRecapContext(db, readyAt);
  // A week in which nothing arrived, nothing moved and nothing was sighted is not worth a message.
  if (!context.arrivalCount && !context.priceMoves.length && !context.codenameCount) return false;
  const batch = db
    .query<{ id: number }, [string, string, string]>(
      "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,0,?,'weekly_recap',?) RETURNING id",
    )
    .get(RECAP_SOURCE, readyAt, JSON.stringify(context));
  if (!batch) throw new Error("Weekly recap batch insert failed");
  for (const destination of targets)
    db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
      batch.id,
      destination.id,
      JSON.stringify(destination),
    );
  return true;
}
