/**
 * Every behaviour of this service that can be switched off without changing code, in one list.
 *
 * Before this existed, switching one off was an edit: the morning list was retired on 2026-09-26 by
 * emptying the signal classes it delivered to, in `src/recap.ts`, and from outside that is
 * indistinguishable from a recap that has been failing quietly for three days. A feature nobody can
 * turn off is edited instead, and an edit leaves no answer to "what is this deployment currently
 * doing"; `features` is that answer, and `featureEnabled` is the only gate that decides it.
 *
 * Sources are not here. They have their own switch in `sourceEnabled`, their own third state --
 * `shadow`, collecting without delivering -- and `capabilities` already reports them. What is here
 * is everything that is not a collector: the periodic messages, the detectors, what reads the
 * readers back, the boards and the models asked about an event.
 */
import type { AppConfig, CredentialName } from "./config.js";

/** The order they are read in, which is the order the consts below are declared and joined. */
type FeatureSection = "periodic" | "detectors" | "readers" | "boards" | "enrichment";

type FeatureDefinition = {
  section: FeatureSection;
  /** What a reader or an operator loses while it is off, in their words rather than the code's. */
  summary: string;
  /**
   * What it does while nothing in the config says otherwise.
   *
   * `false` is a feature that was retired deliberately and kept: the note says why, so the next
   * revision decides from the reason rather than from the silence.
   */
  defaultOn: boolean;
  note?: string;
  /**
   * Why it cannot run even when it is on -- a missing credential, an unconfigured channel. Returning
   * a sentence makes "off because nobody asked for it" and "on but it has nothing to speak through"
   * two different answers, which used to be the same silence.
   */
  unavailable?: (config: AppConfig) => string | null;
};

const needs = (names: readonly CredentialName[]) => (config: AppConfig) =>
  names.filter((name) => !config[name]).map((name) => `${name} is not configured`)[0] ?? null;

const needsAll =
  (checks: readonly ((config: AppConfig) => string | null)[]) =>
  (config: AppConfig): string | null =>
    checks.map((check) => check(config)).find((reason) => reason !== null) ?? null;

const needsDiscordChannel = (what: string, channel: (config: AppConfig) => string | undefined) =>
  needsAll([needs(["DISCORD_BOT_TOKEN"]), (config) => (channel(config) ? null : `no ${what} is configured`)]);

/** The periodic messages: one per period, each its own switch because each has its own readers. */
const PERIODIC = {
  "weekly-recap": {
    section: "periodic",
    summary: "The week's arrivals, price moves and retirements, to the destinations that carry launches.",
    defaultOn: true,
  },
  "daily-recap": {
    section: "periodic",
    summary:
      "One morning list of the moves too small for a card of their own, to the destinations that carry sightings.",
    defaultOn: false,
    note: "Retired on 2026-09-26: over three days it spent eleven of seventeen lines on one catalogue restating models already listed, and each of its scored lines named an effort variant below a number this database already held. `recapContext(db, to, 'day')` still answers, so the reports keep it.",
  },
  "daily-news": {
    section: "periodic",
    summary: "The labs' own posts of the day as headlines: a partnership, an essay, a research result.",
    defaultOn: false,
    note: "Retired on 2026-09-22: filler to a reader on a $20 plan, and already published to the scouts, who came to hear things first.",
  },
  "lifecycle-reminders": {
    section: "periodic",
    summary: "A card before an announced shutdown or deprecation date arrives.",
    defaultOn: true,
  },
} as const satisfies Record<string, FeatureDefinition>;

/** Readings of the stored evidence that speak on their own, without an upstream saying anything new. */
const DETECTORS = {
  breakouts: {
    section: "detectors",
    summary: "A model climbing far enough on a board to be worth a card of its own.",
    defaultOn: true,
  },
  corroboration: {
    section: "detectors",
    summary: "A second independent source agreeing, which turns a sighting into something to announce.",
    defaultOn: true,
  },
} as const satisfies Record<string, FeatureDefinition>;

/** What reads the readers back: their votes on a card, and what those votes are allowed to do. */
const READERS = {
  promotion: {
    section: "readers",
    summary: "An unconfirmed card the scouts vouched for, carried to the wire.",
    defaultOn: true,
    unavailable: (config) => (config.promotion ? null : "no promotion thresholds are configured"),
  },
  "telegram-reactions": {
    section: "readers",
    summary: "The thumbs under a Telegram card, counted for the reports and for a source's standing.",
    defaultOn: true,
    // The token, and not a live destination: the thumbs under a card sent last month are still
    // worth reading after the channel it went to was retired.
    unavailable: needs(["TELEGRAM_BOT_TOKEN"]),
  },
} as const satisfies Record<string, FeatureDefinition>;

/** Messages to the operator's own channel rather than to a subscriber. */
const BOARDS = {
  "status-boards": {
    section: "boards",
    summary:
      "The boards edited in place in the operator's channel: activity, platforms, suppressions, coverage, releases.",
    defaultOn: true,
    unavailable: needsDiscordChannel(
      "status channel",
      (config) => config.statusChannelId ?? config.platformBoardChannelId,
    ),
  },
  "operational-alerts": {
    section: "boards",
    summary: "A private message when collectors go out, as opposed to model news.",
    defaultOn: true,
    unavailable: needsDiscordChannel("alert channel", (config) => config.alertChannelId),
  },
  "review-posts": {
    section: "boards",
    summary: "The monthly audit and the weekly reading of the readers' votes, written into the operator's channel.",
    defaultOn: true,
    unavailable: needsAll([
      needsDiscordChannel("status channel", (config) => config.statusChannelId),
      needs(["DEEPSEEK_API_KEY"]),
    ]),
  },
} as const satisfies Record<string, FeatureDefinition>;

/** What a model is asked about an event. Never evidence: its answers sit beside the record. */
const ENRICHMENT = {
  "jev-verdicts": {
    section: "enrichment",
    summary: "Jev's typed judgement of an event, which votes on whether it speaks and never vetoes.",
    defaultOn: true,
    unavailable: needs(["TYPESAFE_API_KEY"]),
  },
  "deepseek-summaries": {
    section: "enrichment",
    summary: "The written lead under a card and under a recap's entries.",
    defaultOn: true,
    unavailable: needs(["DEEPSEEK_API_KEY"]),
  },
  "publications-sync": {
    section: "enrichment",
    summary: "Posts pulled from Solo Publisher, so a card can link the article that covers it.",
    defaultOn: true,
    unavailable: (config) => (config.SOLO_PUBLISHER_MCP_URL ? null : "no Solo Publisher endpoint is configured"),
  },
} as const satisfies Record<string, FeatureDefinition>;

const FEATURES = { ...PERIODIC, ...DETECTORS, ...READERS, ...BOARDS, ...ENRICHMENT } as const satisfies Record<
  string,
  FeatureDefinition
>;
export type FeatureId = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

export type FeatureState = {
  id: FeatureId;
  section: FeatureSection;
  summary: string;
  note?: string;
  state: "on" | "off" | "unavailable";
  /** Why it is not on: the config key that says so, or what it would need to run. */
  reason?: string;
};

/**
 * The state of one feature, as the report prints it and as the gate reads it.
 *
 * Unavailable beats off on purpose: an operator who removes a credential has not decided anything
 * about the feature, and reading it back as "off" would lose the difference the next morning.
 */
export function featureState(config: AppConfig, id: FeatureId): FeatureState {
  const definition = FEATURES[id] as FeatureDefinition;
  const base = {
    id,
    section: definition.section,
    summary: definition.summary,
    ...(definition.note ? { note: definition.note } : {}),
  };
  const unavailable = definition.unavailable?.(config) ?? null;
  if (unavailable) return { ...base, state: "unavailable", reason: unavailable };
  // Tests and one-off scripts build a config by hand; `loadConfig` always fills this in.
  const chosen = (config.featureEnabled as Record<string, boolean> | undefined)?.[id];
  if (chosen === false) return { ...base, state: "off", reason: "featureEnabled says false" };
  if (chosen === undefined && !definition.defaultOn)
    return { ...base, state: "off", reason: "off by default; set featureEnabled to true to run it" };
  return { ...base, state: "on" };
}

/** The one gate. Anything that can be switched off asks this and nothing else. */
export function featureEnabled(config: AppConfig, id: FeatureId): boolean {
  return featureState(config, id).state === "on";
}

export function featureStates(config: AppConfig): FeatureState[] {
  return FEATURE_IDS.map((id) => featureState(config, id));
}
