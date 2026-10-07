import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { channelMix } from "../reports/channelMix.js";
import { dislikedCards } from "../reports/disliked.js";
import { judgeGap } from "../reports/judgeGap.js";
import { passedOver } from "../reports/passedOver.js";
import { reactionStandings } from "../reports/reactions.js";
import { signalQuality } from "../reports/signalQuality.js";
import { count, type OperationMap } from "./definition.js";

/**
 * Its own declaration rather than another block in the map, because `calibrationOperations` is at
 * the size the gate stops at and this one carries the longest note of the five.
 */
function dislikedOperation(db: Database): OperationMap[string] {
  return {
    section: "sources",
    summary: "The cards a reader marked down, with the handles a rule could cut a whole category by.",
    startHere: "what did the channel not want, and what would it cost to stop sending it",
    note:
      "Read this to have the conversation, not to settle it: nothing here is a verdict on whether " +
      "a card was true. A reader's reason stays in his head -- image models are not what a " +
      "vibe-coding channel reads, a board that is not code is not news -- and this lays the card " +
      "back out beside the handles a rule could be written against, so the reason can be said and " +
      "then written down. `cuts` is the half that decides anything: `disliked` against `cards` is " +
      "how many of that value's cards were marked out of how many arrived, so a cut's price is " +
      "the second number. `modality` is derived rather than stored -- Arena spells it in the " +
      "board, OpenRouter in its input and output arrays, Vercel only in a price per character of " +
      "speech -- and a record that says none of it is `unknown` rather than guessed into a bucket " +
      "somebody would then cut. `alsoSentTo` is there because 'not in this channel' and 'not at " +
      "all' are different fixes. One thumb under a digest is one opinion about every event in it, " +
      "which `events` says.",
    mutates: false,
    agent: true,
    schema: z.object({ days: count(365, 14) }),
    cli: { args: [{ name: "days", optional: true }] },
    http: { method: "get", path: "/api/disliked" },
    handler: (input: { days: number }) => dislikedCards(db, input.days),
  };
}

/**
 * Whether what the sources produced was worth sending, which is a different question from whether
 * they are working.
 *
 * The rest of the "sources" section asks after a collector: what went quiet, what refused a
 * credential, what a source was first to see. These five ask after a judgement -- the readers'
 * thumbs, where Jev and the rules disagree, what a rule held back, what the channel was actually
 * made of -- and they are the ones read together when the question is calibration rather than
 * repair. They stay in the same guide section, because an operator arrives at them by asking about
 * sources; they live in their own file because a section of the registry is not allowed to grow
 * without end, and this was the seam.
 */
export function calibrationOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
    reactions: {
      section: "sources",
      summary: "The thumbs each source and each kind of card drew, and whether there are enough to calibrate on.",
      startHere: "what the channel has actually voted for and against",
      note:
        "The readers' vote is arithmetic on purpose while the counts are this small. This is where " +
        "the question of feeding them to Jev gets answered on evidence rather than on appetite. " +
        "One card is one vote in every cut: a thumb is left under a delivery, and a digest carrying " +
        "twenty-two names is still the one thumb its reader left. Until 2026-10-03 the tally summed " +
        "over the events inside each card instead, which read 42 votes against where 14 cards had " +
        "been voted on. A bot's own reaction is never in here either: Discord subtracts `me` and " +
        "Telegram skips the bot's actor id, so what is counted is what a reader did.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(365, 60) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/reactions" },
      handler: (input: { days: number }) => reactionStandings(db, input.days),
    },

    disliked: dislikedOperation(db),

    judge_gap: {
      section: "sources",
      summary: "Events Jev rated highly that a rule held back, and low-rated events that reached a reader.",
      startHere: "do the routing rules and the classifier agree",
      note:
        "Four tables, and only two of them are bounded by `limit`. `heldBack` and `spoke` are the " +
        "cases themselves, newest and most extreme first, and they are read when the question is " +
        "which rule to change. `streams` and `reasons` count every disagreement in the window " +
        "whatever `limit` left room to print, and they are the shape of it: `judged` is what each " +
        "stream's two numbers are a share of, and `reasons` names the rule behind every held-back " +
        "event, stream by stream -- `--tsv=reasons`. Counting a truncated list instead is how the " +
        "fourteen-day question came out wrong: it hit the ceiling at 200 and read as calibration. " +
        "An event held back at two destinations is one event in `streams` and appears under each " +
        "of its rules in `reasons`, so the reason column sums higher than the stream column. Only " +
        "judgements at the current prompt version count anywhere here, because a worth is a " +
        "property of the question that was asked: the day after a version bump all four are thin, " +
        "and they fill up as the backfill runs.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7), limit: count(200, 25) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/judge-gap" },
      handler: (input: { days: number; limit: number }) => judgeGap(db, input.days, input.limit),
    },

    passed_over: {
      section: "sources",
      summary:
        "Subjects ranked by how many unrelated sources recorded them, and whether a reader ever heard: the misses, with the rules that made each one.",
      startHere: "what did we know about before anyone was told",
      note:
        "Two counts per subject, and only one of them is a miss. `independentSourceCount` is every " +
        "unrelated source that recorded the subject; `arrivalSourceCount` counts only the ones that " +
        "recorded it as an arrival, which is the count the corroboration rule does, and it is what " +
        "`overThresholdAndSilent` and the ordering use. A subject high on the first and zero on the " +
        "second is a catalogue rewriting rows for a model that is already out -- Gemini 3.8 Flash " +
        "and GLM 5.2 Fast both read that way on 2026-09-27 -- and is not something a reader was " +
        "waiting to hear. `lateAndSilent` counts the other half: silent subjects we met more than a " +
        "month after they were there to be met, where lateness starts at the release or at the day " +
        "we began reading a source that carried the subject, whichever is later. Read it beside " +
        "`historyImportsAndSilent`, which counts the subjects that were already out before we were " +
        "on any of their sources: those are a catalogue handing us its history on the first call, " +
        "not misses, and they are what the first version of `lateAndSilent` was entirely made of -- " +
        "32 rows on 2026-09-27, DeepSeek V3 at 623 days among them. `watchedSince` and " +
        "`historyImport` say which a row is. `releasedAt` is null on the roughly two thirds of " +
        "subjects no catalogue dates, and null there means no claim, never a fresh release. " +
        "`heldOnAvailability` is the third class, and the one this report could not see at all: " +
        "silent subjects a catalogue lists and nobody outside the maker can call, which is what the " +
        "week's arrivals now hold rather than discard -- the week a listing opens, the recap reports " +
        "it. Every row in it is a reader correctly not interrupted, so it is a queue length and not " +
        "an alarm. `listings` on a row is the count behind it, callable against unreachable, and " +
        "`nobodyCanCallIt` is the wider fact that nothing we hold about the subject can be called at " +
        "all: true of Gemini 4 Argon on the evening of 2026-09-30, and true of every post a company " +
        "makes about its quarter, which is why the number counts the narrower thing.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7), limit: count(200, 50) }),
      cli: {
        args: [
          { name: "days", optional: true },
          { name: "limit", optional: true },
        ],
      },
      http: { method: "get", path: "/api/passed-over" },
      handler: (input: { days: number; limit: number }) => passedOver(db, input.days, input.limit),
    },

    channel_mix: {
      section: "sources",
      summary:
        "What each destination actually carried: signal classes delivered or unrouted, lead-time " +
        "share, who raised the batches, and promotions.",
      startHere: "what the public channel is really full of",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/channel-mix" },
      handler: (input: { days: number }) => channelMix(db, config, input.days),
    },

    signal_quality: {
      section: "sources",
      summary: "Source collection, event, delivery and suppression metrics for an operator-selected period.",
      startHere: "is a source earning its place in the feed",
      note:
        "`suppressedEvents` is the verdict the store recorded when it wrote the event, not the " +
        "policy run again today: it counts what this service actually stayed quiet about. Events " +
        "stored before that verdict was kept are `eventsWithoutAVerdict` rather than either, so a " +
        "window reaching back before 2026-09-27 reports fewer suppressions than it had -- a " +
        "seven-day window is clear of them a week after that date.",
      mutates: false,
      agent: true,
      schema: z.object({ days: count(90, 7) }),
      cli: { args: [{ name: "days", optional: true }] },
      http: { method: "get", path: "/api/signal-quality" },
      handler: (input: { days: number }) => signalQuality(db, config, input.days),
    },
  };
}
