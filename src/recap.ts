import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig, Destination } from "./config.js";
import { breakoutOf } from "./events/breakouts.js";
import { signalOf } from "./events/classify.js";
import { readableName } from "./events/naming.js";
import { isScheduledPricingRotation } from "./events/oscillation.js";
import { renamedEvents } from "./events/rename.js";
import { priceMoveRatio, pricePair, significantPriceChange } from "./events/render/common.js";
import {
  ANNOUNCEMENT_STREAMS,
  boardPlace,
  DEBUT_PLACES,
  isMainBoard,
  isUnfollowedMakerAtAReseller,
  type SignalClass,
} from "./events/signals.js";
import type { Event, RecordData } from "./events/types.js";
import {
  arrivalWeight,
  isBesideTheRelease,
  isModelVariant,
  isRepublished,
  isTrainingArtefact,
  modelSubject,
  oneLinePerModel,
  tierBase,
} from "./events/variants.js";
import { vendorOf, vendorOfName } from "./events/vendors.js";
import { subjectKey, usageRanks, witnessedSubjects } from "./events/witness.js";
import { isNewsworthyStory, notableCommits, worthCutoffs } from "./insights.js";
import { judgementOf } from "./jev.js";
import { sourceLabel } from "./sources/labels.js";

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
/**
 * The same summary over a day, for the invited room. The scouts are told every sighting as it
 * happens and nothing about the numbers that move too little to speak on their own: a price cut,
 * a board changing hands at the top. One message a morning says those, and never pings.
 */
/**
 * Which destinations a period's recap goes to, by the classes they carry. A day is two things for
 * two rooms: price moves are `change`, read by the public wire as news of what they pay; a board
 * changing hands at the top is read by the scouts beside their sightings. A destination gets the
 * part of the day its classes ask for, and nothing when that part is empty.
 */
const PERIODS = {
  // `untold`: only moves no card carried. A week is what moved furthest, told or not; a day is the
  // moves too small for a card of their own, and says so in its footer.
  week: { source: "weekly-recap", ms: 7 * 24 * 3_600_000, signals: ["launch"], untold: false },
  // Nobody's since 2026-09-26. The morning list was built from what is easy to count rather than
  // from what the room could not find out by itself: over 24, 25 and 26 September it spent eleven of
  // its seventeen lines on one catalogue restating models it had already listed, on a six-week-old
  // image model and on a roleplaying model, and its three scored lines each named an effort variant
  // whose number was below the one this database already held for the model -- GLM-5.3 at 34.3 when
  // (max) had been 44.9 here since 19 September. A room told the wrong number is worse served than a
  // room told nothing. Kept for the reports, and `recapContext(db, to, "day")` still answers.
  day: { source: "daily-recap", ms: 24 * 3_600_000, signals: [], untold: true },
  // What the labs published in a day, for the wire: a partnership, an essay, a research result is
  // the vendor talking rather than a model changing, so it is never a card of its own, and on
  // 2026-09-16 "Mistral X Mozilla" and "Claude Cowork and chat are now one Claude" reached nobody.
  // One morning list of headlines carries them without making the wire louder.
  // Nobody's since 2026-09-22: to a reader on a $20 plan a day of lab posts was filler, and to the
  // scouts, who came to hear first, it is what everyone already published. Kept for the reports.
  news: { source: "daily-news", ms: 24 * 3_600_000, signals: [], untold: true },
} as const;
export type RecapPeriod = keyof typeof PERIODS;
/**
 * The labs' own newsrooms and sites, whose posts are the day's official news. Not Hacker News,
 * which is other people talking about it, not a help centre, and not a source still on trial in
 * shadow: NVIDIA's blog was removed once as marketing and has to earn its way back in.
 */
const NEWS_DESKS = new Set([
  "openai-news",
  "anthropic-news",
  "claude-blog",
  "google-ai-blog",
  "gemini-models-blog",
  "gemini-app-blog",
  "deepmind-blog",
  "pages:openai",
  "pages:anthropic",
  "pages:xai",
  "pages:deepmind",
  "pages:google-devs",
  "pages:mistral",
  "pages:zai",
]);
const HEADLINES = 10;
/**
 * Lines one maker may take in one section before the rest are counted. OpenAI filed eight misuse
 * reports on 2026-09-17, each on its newsroom and again on its site: sixteen lines about one
 * afternoon would be the whole message.
 */
const PER_MAKER = 2;
/** The sections of the day's news, in the order they are read. Business is kept and never sent. */
const TOPICS = { safety: "safety", research: "research", article: "other" } as const;
/** A climb this steep into the top ten is a model the experts will ask about; smaller moves are churn. */
const CLIMB_PLACES = 5;

/** "Arena text", "Artificial Analysis text-to-image", "DesignArena website": the board as said aloud. */
function boardName(source: string, category: unknown): string {
  const site = sourceLabel(source).split(" · ")[0] ?? source;
  const board = String(category ?? "")
    .split("/")
    .map((part) => (part === "quality" ? "Intelligence Index" : part))
    .filter((part) => part && part !== "overall" && part !== "artificial-analysis" && part !== "designarena")
    .join(" ");
  return board ? `${site} ${board}` : site;
}

/** Where a thing shows up before anyone announces it. */
const EARLY_STREAMS = new Set(["arena", "pages"]);
/** Makers named in the recap itself; the rest are counted. */
const ARRIVAL_GROUPS = 6;
/** How far ahead a retirement is still something to plan around: one quarter. */
const RETIREMENT_HORIZON_MS = 92 * 24 * 60 * 60 * 1000;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const recapContextSchema = z.object({
  // Absent in the recaps stored before a day could be summarised.
  period: z.enum(["week", "day", "news"]).default("week"),
  from: z.string(),
  to: z.string(),
  arrivals: z.array(z.object({ vendor: z.string(), names: z.array(z.string()) })),
  arrivalCount: z.number(),
  priceMoves: z.array(
    z.object({
      name: z.string(),
      percent: z.number(),
      cheaper: z.boolean(),
      // Dollars per million tokens, before and after. Absent in the recaps stored before a line
      // said what a reader would actually be charged.
      from: z.number().nullable().default(null),
      to: z.number().nullable().default(null),
      // Which of the quoted prices moved. Absent before the line said so.
      field: z.string().default(""),
      // Absent in the recaps already stored before this was told apart from a decision to charge more.
      discountEnded: z.boolean().default(false),
    }),
  ),
  codenameCount: z.number(),
  leaders: z.array(z.object({ board: z.string(), name: z.string() })).default([]),
  // Absent in the recaps stored before a week named what is going away.
  retirements: z.array(z.object({ name: z.string(), date: z.string().nullable() })).default([]),
  // A maker's own sentence about something going away, when it said so in a changelog rather than
  // in a lifecycle table. Absent in the recaps stored before the two were told apart.
  retirementNotes: z.array(z.string()).default([]),
  // Absent in the recaps stored before a day's official news was listed.
  headlines: z
    .array(
      z.object({
        vendor: z.string(),
        title: z.string(),
        url: z.string().nullable(),
        // Absent in the news stored before the day was read in sections.
        topic: z.enum(["safety", "research", "other"]).default("other"),
        // Lines past the maker's share, counted rather than listed.
        more: z.number().default(0),
        // Whether a lab said this itself. A front-page story is somebody else talking about a lab,
        // and under "Also from the labs" it read as the lab's own post. Absent before the two were
        // told apart; the recaps stored then were all desks.
        desk: z.boolean().default(true),
        // What a safety or research post found, in a sentence. Absent before the day was read for it.
        summary: z.string().nullable().default(null),
      }),
    )
    .default([]),
  // Absent in the recaps stored before the scouts were told about climbs and new boards.
  climbers: z.array(z.object({ board: z.string(), name: z.string(), from: z.number(), to: z.number() })).default([]),
  newBoards: z.array(z.object({ board: z.string(), leader: z.string().nullable() })).default([]),
  resellerArrivals: z
    .array(
      z.object({
        name: z.string(),
        reseller: z.string(),
        // Who made it, when the catalogue says. Absent before the line named anyone but the shop.
        maker: z.string().default(""),
        // The other shops that listed the same model the same day. Absent before one line covered
        // them all, when a second shop read as a second launch.
        alsoOn: z.array(z.string()).default([]),
        // Rows this line stands for beyond one per shop: the dated snapshots and billing tiers the
        // catalogue wrote about a model it had already written about.
        variants: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
  // Commits worth a line, as a sentence each. Absent before the repositories were read for them.
  codeNotes: z.array(z.object({ repo: z.string(), text: z.string() })).default([]),
  // Absent in the recaps stored before the Intelligence Index was read for new entries.
  indexed: z.array(z.object({ name: z.string(), index: z.number(), place: z.number().nullable() })).default([]),
});
export type RecapContext = z.infer<typeof recapContextSchema>;

/**
 * The end of the most recent complete week, as an instant.
 *
 * Sunday evening UTC: late enough that a week's last day is over in the Americas, early enough that
 * Asia reads it on Monday morning rather than a day later.
 */
export function lastRecapPeriod(now: number, period: RecapPeriod = "week"): string {
  const end = new Date(now);
  // The day closes at 06:00 UTC, which is the start of the morning in Moscow and the evening before
  // on the American west coast: the room reads it with coffee rather than at midnight.
  end.setUTCHours(period === "week" ? 18 : 6, 0, 0, 0);
  while ((period === "week" && end.getUTCDay() !== 0) || end.getTime() > now) end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString();
}

function recordOf(event: Event): RecordData | null {
  const body = event.after_json ?? event.before_json;
  return body ? (JSON.parse(body) as RecordData) : null;
}

function nameOf(event: Event): string {
  return String(recordOf(event)?.name ?? event.entity_id);
}

/** The streams where a row appearing means a model became available, whoever is doing the listing. */
const CATALOGUE_STREAMS = new Set(["api-models", "openrouter", "weights"]);

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
  // Only a stream that lists models can say a model arrived. `launch` is a class about what a
  // reader wants to hear now, and a severe outage, a changelog headline and a credit notice all
  // earn it: "Elevated errors affecting ChatGPT Work mode" and "Codex banked reset credit
  // announced" were both counted among the week's 53 models.
  if (!CATALOGUE_STREAMS.has(event.stream)) return false;
  // Only a registry says what an artefact is; a catalogue row is a model by construction.
  if (event.stream === "weights" && isBesideTheRelease(record)) return false;
  // A reseller's catalogue gains rows faster than the field gains models, and most of them are
  // narrow developer tools: Inference.net's Schematron is a 3B model that turns HTML into JSON,
  // which is a useful thing and not a week's news for anyone who is not parsing websites. Nothing
  // else we collect has ever heard of it -- no benchmark, no arena, no maker's API -- so the only
  // judgement available is whether the maker is one this tracker follows. Adding a maker to that
  // table is how a new name gets in, and it is one line.
  if (event.stream === "openrouter" && vendorOf(event, record) === "Unknown") return false;
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

/**
 * Everything a period is read from, read once.
 *
 * Every line of a recap is a different question about the same window, and each of them needs some
 * of the same five readings: what happened in it, which of those events were renames, which models
 * anything else has ever seen, what people actually run, and what already went out as a card. They
 * are gathered here so that each line below is a function of the window rather than of a hundred
 * lines of setup above it.
 */
type PeriodReading = {
  db: Database;
  period: RecapPeriod;
  from: string;
  to: string;
  classified: { event: Event; signal: SignalClass }[];
  renamed: Set<number>;
  witnessed: Set<string>;
  usage: Map<string, number>;
  /** Events a card already carried, for the periods whose lines are only what was never told. */
  carded: Set<number>;
};

function periodReading(db: Database, to: string, period: RecapPeriod): PeriodReading {
  const from = new Date(Date.parse(to) - PERIODS[period].ms).toISOString();
  const events = db
    .query<Event, [string, string]>("SELECT * FROM events WHERE detected_at>=? AND detected_at<? ORDER BY id")
    .all(from, to);
  const classified = events.map((event) => ({ event, signal: signalOf(event) }));
  const renamed = renamedEvents(db, events);
  const witnessed = witnessedSubjects(db);
  const usage = usageRanks(db);
  // On 2026-09-18 the morning recap repeated GLM 5.2, Kimi K3 and gpt-oss-120b from cards sent
  // hours before.
  const carded = new Set(
    !PERIODS[period].untold
      ? []
      : db
          .query<{ event_id: number }, [string, string]>(
            `SELECT DISTINCT de.event_id FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
         JOIN events e ON e.id=de.event_id
         WHERE d.status IN ('pending','sending','sent','ambiguous','verification_required')
           AND e.detected_at>=? AND e.detected_at<?`,
          )
          .all(from, to)
          .map((row) => row.event_id),
  );
  return { db, period, from, to, classified, renamed, witnessed, usage, carded };
}

/**
 * What arrived, grouped by maker, and the subjects those arrivals are about.
 *
 * The subjects come back with them because a name this period reports as arrived is not also a name
 * it reports as retiring.
 */
function periodArrivals(reading: PeriodReading): {
  arrivals: RecapContext["arrivals"];
  arrivalCount: number;
  arrived: Set<string>;
} {
  const { db, from, to, classified, renamed } = reading;
  const events = classified.map(({ event }) => event);
  // What anything had already named before the period began. A catalogue listing a model is not
  // the model arriving: OpenRouter carried GLM 5.2 and GLM 5.3 on 8 September and OpenAI's own API
  // carried gpt-live-1 on the 10th, and all three were reported as this week's arrivals because a
  // second catalogue caught up inside the week. The first time anything names it is the week it
  // arrived, and every week after that it is furniture.
  const alreadyNamed = new Set(
    db
      .query<{ name: string }, [string]>(
        "SELECT COALESCE(json_extract(after_json,'$.name'), entity_id) AS name FROM events WHERE detected_at<?",
      )
      .all(from)
      .map((row) => modelSubject(String(row.name ?? ""))),
  );
  // Something has to date a model to this week before the week claims it. Our own history is the
  // weakest possible evidence -- it begins when this tracker did, so everything older than that
  // looks new the first time a catalogue mentions it, and MiniMax M2.7, published in March, was
  // reported as an arrival of 15 September. Two things can date a model: a catalogue publishing a
  // creation date inside the period, or the maker announcing it by name inside the period.
  const datedThisPeriod = new Set(
    events
      .filter((event) => {
        const created = Date.parse(String(recordOf(event)?.created ?? ""));
        return Number.isFinite(created) && created >= Date.parse(from) && created < Date.parse(to);
      })
      .map((event) => modelSubject(nameOf(event))),
  );
  // Everything the makers themselves published this period, as one body of text. "Introducing
  // Gemini 3.8 Live and 3.8 Live Extended Thinking" dates both models no catalogue dated, and the
  // whole name has to appear: xAI's "Grok Voice Transcribe 2.0" is not a word about Grok Voice STT.
  const announced = ANNOUNCEMENT_STREAMS.size
    ? classified
        .filter(({ event }) => ANNOUNCEMENT_STREAMS.has(event.stream))
        .map(({ event }) => nameOf(event).toLowerCase())
        .join("\n")
    : "";
  // One model however many collectors saw it, and the maker's own word ahead of a reseller's.
  const bySubject = new Map<string, { name: string; vendor: string; weight: number }>();
  for (const { event, signal } of classified) {
    // A week is read for what arrived, which is a wider question than what was worth interrupting
    // a reader for. A reseller listing a model is a sighting rather than a launch and never
    // reaches the public channel on its own, but it is still the week's first word that the model
    // exists, and the weighting below already prefers the maker's own word over a reseller's.
    const arrived = signal === "launch" || signal === "codename";
    if (!arrived || event.kind !== "new" || !isRealArrival(event, renamed)) continue;
    const record = recordOf(event);
    // A catalogue adding a row is not a model being born. Groq listed Compound Mini and OpenRouter
    // re-listed gpt-oss inside one week, and the week read as though GPT-OSS had just come out. The
    // registry's own date settles it: dated before the week, it is a listing, not an arrival.
    const created = Date.parse(String(record?.created ?? ""));
    if (Number.isFinite(created) && created < Date.parse(from)) continue;
    const name = nameOf(event);
    const subject = modelSubject(name);
    if (alreadyNamed.has(subject)) continue;
    // Dated to this period by a catalogue, or named in something a maker published in it. A
    // catalogue row with no date behind it says only that the catalogue has the model today.
    const readable = readableName(name).toLowerCase();
    if (!datedThisPeriod.has(subject) && !(readable.length >= 5 && announced.includes(readable))) continue;
    // A tier is not a model. "MiniMax M3 Fast" and "Jev 1.13 Free" are ways of billing something
    // already here, and only the catalogue's own words say so -- so the trailing word only folds
    // away when the thing it is a tier of is something we have seen.
    const base = tierBase(name);
    if (base && (alreadyNamed.has(base) || bySubject.has(base))) continue;
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
  return {
    arrivals,
    arrivalCount: ranked.length,
    arrived: new Set([...bySubject.values()].map((arrival) => modelSubject(arrival.name))),
  };
}

/** One model, one price line: the period's net move, told only for a model something else knows. */
function periodPriceMoves(reading: PeriodReading): RecapContext["priceMoves"] {
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

/** A board changing hands at the top is the one ranking move a reader repeats to somebody else. */
function periodLeaders(reading: PeriodReading): RecapContext["leaders"] {
  const { classified } = reading;
  const leaders = classified
    .filter(({ event }) => event.stream === "leaderboards" && event.kind === "changed")
    .flatMap(({ event }) => {
      const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
      const after = recordOf(event);
      // A board that starts counting places is not a model taking first: the Intelligence Index gained
      // ranks on 2026-09-20, and every row's first place would otherwise read as a new leader.
      if (Number(after?.rank) !== 1 || !Number.isInteger(Number(before?.rank)) || Number(before?.rank) === 1) return [];
      return [{ board: String(after?.category ?? event.source), name: readableName(nameOf(event)) }];
    })
    .filter((leader, index, all) => all.findIndex((other) => other.board === leader.board) === index)
    .slice(0, 5);
  return leaders;
}

/** What the maker said is going away, from a lifecycle table and from its own changelog sentence. */
function periodRetirements(
  reading: PeriodReading,
  arrivedThisPeriod: Set<string>,
): { retirements: RecapContext["retirements"]; retirementNotes: string[] } {
  const { classified, period, to } = reading;
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
    // A date has to be near enough to act on. "Claude Mythos 5 (9 Jun 2027)" is twenty-one months
    // away and changes nothing a reader does this week; a line nothing can be read from at all is
    // not worth the ink either, so both go.
    .filter(
      (retirement) =>
        Number.isFinite(retirement.at) &&
        retirement.at >= Date.parse(to) &&
        retirement.at - Date.parse(to) <= RETIREMENT_HORIZON_MS,
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
// The day's news in three sections: what went wrong or could, what was found, and what else the
// labs said. Hacker News is read for the first two only: other people's safety and research
// stories are news, other people's opinions are not.
function periodHeadlines(reading: PeriodReading): RecapContext["headlines"] {
  const { db, classified, carded, period, to } = reading;
  const headlines: RecapContext["headlines"] = [];
  if (period === "news") {
    // A front-page story no pattern placed is still read when Jev judged it about a model, a product
    // or a risk: "Alibaba open-sources a model that detects 150 conditions" was nobody's on 2026-09-19.
    // Read once: the cutoff is a property of the period, not of each story in it.
    const storyCutoff = worthCutoffs(db, new Date(to)).story;
    const told = (event: Event, signal: string) =>
      signal === "article"
        ? NEWS_DESKS.has(event.source) ||
          (event.source === "hackernews" && isNewsworthyStory(judgementOf(db, event.id), storyCutoff))
        : NEWS_DESKS.has(event.source) || event.source === "hackernews";
    // A lab's own feed first, its site second, the front page last: the same post is often on all three.
    const order = (source: string) => (source === "hackernews" ? 2 : source.startsWith("pages:") ? 1 : 0);
    for (const [signal, topic] of Object.entries(TOPICS) as [
      keyof typeof TOPICS,
      (typeof TOPICS)[keyof typeof TOPICS],
    ][]) {
      const lines = classified
        .filter(
          ({ event, signal: seen }) =>
            seen === signal && event.kind === "new" && told(event, signal) && !carded.has(event.id),
        )
        .sort((one, other) => order(one.event.source) - order(other.event.source) || one.event.id - other.event.id)
        .map(({ event }) => {
          const record = recordOf(event);
          // Site pages are titled "OpenAI: Detecting wildfires early"; the vendor is the line's own label.
          const title = nameOf(event).replace(/^[^:]{1,40}:\s+/, "");
          // A front-page story is somebody else's; when it names no maker, the line says where it was read.
          const vendor = vendorOf(event, record);
          return {
            vendor: vendor === "Unknown" && event.source === "hackernews" ? "Hacker News" : vendor,
            desk: event.source !== "hackernews",
            title,
            url: typeof record?.url === "string" ? record.url : null,
            summary:
              topic === "other"
                ? null
                : (db.query<{ text: string }, [number]>("SELECT text FROM summaries WHERE event_id=?").get(event.id)
                    ?.text ?? null),
          };
        })
        .filter((line, index, all) => all.findIndex((other) => other.title === line.title) === index);
      const shown = new Map<string, RecapContext["headlines"][number]>();
      const count = new Map<string, number>();
      for (const line of lines) {
        const held = count.get(line.vendor) ?? 0;
        count.set(line.vendor, held + 1);
        if (held < PER_MAKER) {
          const entry = { ...line, topic, more: 0 };
          headlines.push(entry);
          shown.set(line.vendor, entry);
        } else {
          const last = shown.get(line.vendor);
          if (last) last.more++;
        }
      }
    }
  }
  return headlines;
}

/** What the scoreboards did overnight: big climbs, first scores, and boards that are new today. */
function periodBoards(reading: PeriodReading): {
  climbers: RecapContext["climbers"];
  indexed: RecapContext["indexed"];
  newBoards: RecapContext["newBoards"];
} {
  const { db, classified, period } = reading;
  // Big climbs into the top ten and boards that did not exist yesterday: what the scouts' own
  // sightings do not show, told once a morning beside the new leaders.
  const climbers =
    period !== "day"
      ? []
      : classified
          .filter(({ event }) => event.stream === "leaderboards" && event.kind === "changed")
          .flatMap(({ event }) => {
            const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
            const after = recordOf(event);
            const from = Number(before?.rank);
            const to = Number(after?.rank);
            if (!isMainBoard(after?.category) || !Number.isInteger(from) || !Number.isInteger(to)) return [];
            if (to < 2 || to > DEBUT_PLACES || from - to < CLIMB_PLACES) return [];
            return [{ board: boardName(event.source, after?.category), name: readableName(nameOf(event)), from, to }];
          })
          .sort((one, other) => other.from - other.to - (one.from - one.to))
          .filter((climb, index, all) => all.findIndex((other) => other.name === climb.name) === index)
          .slice(0, 5);
  // Every model Artificial Analysis scored for the first time, wherever it landed: a debut card
  // already told the top ten, and the rest is still the first independent reading of a new model.
  const indexed =
    period !== "day"
      ? []
      : classified
          .filter(({ event }) => event.source === "artificial-analysis" && event.kind === "new")
          .flatMap(({ event }) => {
            const record = recordOf(event);
            const score = record?.score as Record<string, unknown> | undefined;
            const index = score?.artificial_analysis_intelligence_index;
            if (typeof index !== "number") return [];
            return [{ name: readableName(nameOf(event)), index, place: boardPlace(event) }];
          })
          .sort((one, other) => other.index - one.index)
          .slice(0, 5);
  const newBoards: RecapContext["newBoards"] = [];
  if (period === "day") {
    // A board is new when every row it has arrived inside the day. Asking whether any event named it
    // before is not the same question: a board read since the first collection and never moved has
    // no events at all.
    const byBoard = new Map<string, { source: string; category: string; leader: string | null; arrived: number }>();
    for (const { event } of classified) {
      if (event.stream !== "leaderboards" || event.kind !== "new") continue;
      const record = recordOf(event);
      const category = String(record?.category ?? "");
      const key = `${event.source}\u0000${category}`;
      const board = byBoard.get(key) ?? { source: event.source, category, leader: null, arrived: 0 };
      board.arrived++;
      if (boardPlace(event) === 1) board.leader = readableName(nameOf(event));
      byBoard.set(key, board);
    }
    for (const board of byBoard.values()) {
      const rows =
        db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) n FROM records WHERE source=? AND json_extract(body,'$.category')=?",
          )
          .get(board.source, board.category)?.n ?? 0;
      if (board.arrived >= rows && board.arrived >= 3)
        newBoards.push({ board: boardName(board.source, board.category), leader: board.leader });
    }
  }
  return { climbers, indexed, newBoards };
}

/** Small companies' models at resellers, and the commits worth a sentence. */
function periodSightings(reading: PeriodReading): {
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
            const created = Date.parse(String(recordOf(event)?.created ?? ""));
            return !Number.isFinite(created) || created >= Date.parse(from);
          })
          .map(({ event }) => {
            const record = recordOf(event);
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

/**
 * What the scouts actually saw early: something unannounced showing up where it should not be yet.
 *
 * Distinct subjects, not events: the arena and the leaderboards are re-read all week, and counting
 * every observation turns "the scouts saw ten things early" into five figures. A model taking a
 * place on one more scoreboard is a `codename` by class and is not that.
 */
function periodCodenameCount(reading: PeriodReading): number {
  return new Set(
    reading.classified
      .filter(
        ({ event, signal }) =>
          signal === "codename" && EARLY_STREAMS.has(event.stream) && !event.source.startsWith("discovery:"),
      )
      .map(({ event }) => modelSubject(nameOf(event))),
  ).size;
}

/**
 * One period, as the lines a message is written from.
 *
 * Each line is its own function of the same reading, because the lines are independent of each
 * other and the question "why does the day say this" should be answerable by reading one of them.
 */
export function recapContext(db: Database, to: string, period: RecapPeriod = "week"): RecapContext {
  const reading = periodReading(db, to, period);
  const { arrivals, arrivalCount, arrived } = periodArrivals(reading);
  const { retirements, retirementNotes } = periodRetirements(reading, arrived);
  const { climbers, indexed, newBoards } = periodBoards(reading);
  const { resellerArrivals, codeNotes } = periodSightings(reading);
  return recapContextSchema.parse({
    period,
    codeNotes,
    resellerArrivals,
    headlines: periodHeadlines(reading).slice(0, HEADLINES),
    climbers,
    newBoards: newBoards.slice(0, 3),
    indexed,
    leaders: periodLeaders(reading),
    retirements,
    retirementNotes,
    from: reading.from,
    to,
    arrivals: arrivals.slice(0, ARRIVAL_GROUPS),
    arrivalCount,
    priceMoves: periodPriceMoves(reading),
    codenameCount: periodCodenameCount(reading),
  });
}

/**
 * Queue the recaps for the periods that have just ended, once each.
 *
 * The week goes to the destinations that carry launches, which is the wire a reader follows for
 * what they can use. The day goes to the destinations that carry sightings: the invited room sees
 * every event as it happens, and what it does not see is the small movement that never speaks.
 */
export function scheduleRecaps(db: Database, config: AppConfig, now = Date.now()): RecapPeriod[] {
  return (Object.keys(PERIODS) as RecapPeriod[]).filter((period) => scheduleRecap(db, config, period, now));
}

function scheduleRecap(db: Database, config: AppConfig, period: RecapPeriod, now: number): boolean {
  const { source, signals } = PERIODS[period];
  const readyAt = lastRecapPeriod(now, period);
  const targets = (config.destinations as Destination[]).filter((destination) =>
    signals.some((signal) => destination.signals.includes(signal)),
  );
  if (!targets.length) return false;
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM batches WHERE kind='weekly_recap' AND source=? AND ready_at=?",
    )
    .get(source, readyAt);
  if (existing) return false;
  const context = recapContext(db, readyAt, period);
  // A period in which nothing arrived, nothing moved and nothing was sighted is not worth a message;
  // a day is only ever about what moved.
  const empty =
    period === "news"
      ? !context.headlines.length
      : period === "day"
        ? !context.leaders.length &&
          !context.climbers.length &&
          !context.newBoards.length &&
          !context.resellerArrivals.length &&
          !context.codeNotes.length &&
          !context.indexed.length
        : !context.arrivalCount &&
          !context.priceMoves.length &&
          !context.codenameCount &&
          !context.retirements.length &&
          !context.retirementNotes.length;
  if (empty) return false;
  const batch = db
    .query<{ id: number }, [string, string, string]>(
      "INSERT INTO batches(source,digest,ready_at,kind,context_json) VALUES(?,0,?,'weekly_recap',?) RETURNING id",
    )
    .get(source, readyAt, JSON.stringify(context));
  if (!batch) throw new Error("Recap batch insert failed");
  for (const destination of targets)
    db.query("INSERT INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
      batch.id,
      destination.id,
      JSON.stringify(destination),
    );
  return true;
}
