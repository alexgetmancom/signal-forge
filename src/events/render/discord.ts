import { sourceLabel } from "../../sources/labels.js";
import { readerStanding } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import {
  boardPlace,
  DEBUT_PLACES,
  isStealthLaunch,
  listsAnotherMakersModel,
  scoredDebutIndex,
  stealthSubject,
} from "../signals.js";
import type { Event, RecordData } from "../types.js";
import type { Banner } from "./banner.js";
import { DESCRIPTION_CHARACTERS } from "./budget.js";
import { describe, type Fact, factText, pricePair, prices, withoutMakerPrefix } from "./common.js";
import { type CardContext, eventFactParts } from "./facts.js";
import { sourceLogo, vendorColor, vendorLogo } from "./logos.js";
import { cardColor } from "./palette.js";

const EYEBROWS: Record<string, string> = {
  "api-models": "MODEL CATALOGUE",
  openrouter: "AVAILABILITY",
  arena: "ARENA",
  leaderboards: "LEADERBOARD",
  news: "OFFICIAL NEWS",
  web: "INTERFACE",
  github: "REPOSITORY",
  weights: "OPEN WEIGHTS",
  packages: "PACKAGE",
  incidents: "PLATFORM HEALTH",
  deprecations: "RETIREMENT",
  apps: "APP RELEASE",
  pages: "NEW PAGES",
  resets: "USAGE LIMITS",
  training: "TRAINING RUN",
};

/** Streams where a new row is a model someone can use or download, told in its maker's colour. */
const MODEL_STREAMS = new Set(["api-models", "openrouter", "weights"]);

const KIND_ICONS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };

function eyebrow(event: Event): string {
  if (event.source === "codex-docs") return "DOCUMENTATION";
  if (event.stream === "leaderboards") return sourceLabel(event.source).toUpperCase();
  return EYEBROWS[event.stream] ?? "UPDATE";
}

/**
 * The name of the thing, with an icon for what happened to it. The eyebrow above already names the
 * kind of surface and the first line of the body says what it means, so a card that also spells
 * out "Model availability updated" spends a reader's attention on grammar rather than on the name.
 */
/**
 * A reseller row from a maker we do not track reaches a reader as its bare product name: Vercel's
 * `fish-audio/s1` and `fish-audio/s2-pro` went out on 2026-09-18 as "S1" and "S2 Pro", which say
 * nothing about what moved. The row names its maker, so the title does.
 */
function withUntrackedMaker(name: string, vendor: string, record: RecordData | null): string {
  if (vendor !== "Unknown") return name;
  const maker = typeof record?.maker === "string" ? record.maker.trim() : "";
  if (!maker) return name;
  const readable = /[A-Z]/.test(maker)
    ? maker
    : maker
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  return name.toLowerCase().includes(readable.toLowerCase()) ? name : `${readable} ${name}`;
}

/** A model ID seen in a watched repository's code, commits, issues or pull requests. */
function mentionSighting(event: Event): boolean {
  return event.stream === "github" && /^github:.+:(?:models|talk)$/.test(event.source);
}

/**
 * What a model ID in a repository means, said plainly. "gpt-6-luna served" over "From the
 * project's repository. Work in progress, not a release. Repository activity is not a release.
 * served" reached the scouts on 2026-09-21 and the owner could not tell what had happened: a
 * backend had answered as `gpt-6-luna`, an unannounced model.
 */
function mentionSentence(record: RecordData): string {
  const line = typeof record.line === "string" && record.line.trim() ? `> ${excerpt(record.line.trim(), 200)}` : null;
  const lead =
    record.stage === "served" ? "Not in any catalogue yet." : "Not in any catalogue, not seen answering yet.";
  // The quote is the evidence; the commit title under it was grey text the size of the sentence,
  // since Discord draws no small print inside an embed, and the title links to the commit anyway.
  return [lead, line].filter(Boolean).join("\n");
}

/**
 * A slug has no dots, so `grok-4-8` came out as "Grok 4 8". A lone digit after a name followed by one
 * more lone digit is a version; a date or a longer run of numbers is left as it was. Done when the
 * card is drawn: the stored page name is what later polls compare against.
 */
export function versioned(title: string): string {
  return title.replace(/(?<=[A-Za-z] )(\d) (\d)(?![\d ]*\d)(?=$| [A-Za-z])/g, "$1.$2");
}

function eventHeadline(event: Event, name: string, incident: Incident | null): string {
  if (event.stream === "deprecations" && event.kind === "new") return `⚠️ ${name} is being retired`;
  if (incident) return `${incident.icon} ${incident.icon === "🟢" ? "Resolved · " : ""}${name}`;
  if (mentionSighting(event)) {
    const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const model = typeof record?.model === "string" ? record.model : name;
    if (record?.stage === "served") return `📡 ${model} is answering requests`;
    if (event.kind === "new") return `🔎 ${model} named in code`;
  }
  if (event.stream === "arena" && event.kind === "new") return `🆕 ${name} appears on Arena`;
  // A docs page for a model nobody sells yet: the page is the sighting, not a new model.
  if (event.stream === "pages" && event.kind === "new") return `📄 New page: ${versioned(name)}`;
  if (event.stream === "training") {
    const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const maker = typeof record?.maker === "string" ? `${record.maker} ` : "";
    if (record?.ended) return `🏁 ${maker}finished training ${name}`;
    if (event.kind === "new") return `🧪 ${maker}is training ${name}`;
  }
  // A debut is read for one number, the place, so the title says it before the reader opens the card.
  if (event.stream === "leaderboards" && event.kind === "new") {
    const place = boardPlace(event);
    if (place !== null && place <= DEBUT_PLACES) return `🏆 ${name} debuts at #${place}`;
    // Below the ranked places there is no place to report, so the card leads on the measurement,
    // which is the only reason the arrival is being told at all.
    const index = scoredDebutIndex(event);
    if (index !== null) return `🧠 ${name} enters at ${index} on the Intelligence Index`;
  }
  // A release is its name and version; "Released on npm." under "🆕 codex@latest" was the title again.
  const release = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const version = typeof release?.version === "string" ? release.version : null;
  if (event.stream === "packages" && event.kind !== "removed" && version)
    return `📦 ${name.replace(/@[^@/]+$/, "")} ${version} on ${place(event.source)}`;
  if (event.stream === "apps" && event.kind !== "removed" && version) return `📱 ${name} ${version}`;
  if (event.stream === "resets") {
    const reset = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    // Confirmed: the tracker moved it into its history once the announcer said it had propagated.
    if (reset?.stage === "Applied")
      return reset.resetType === "banked"
        ? "💳 A free Codex reset is banked for everyone"
        : "🎉 Codex limits are back — for everyone";
    return `⏳ ${name.replace(/ usage limits /, " limits ")}`;
  }
  return `${KIND_ICONS[event.kind]} ${name}`;
}

/** Early signs of a model, read on the scouts channel, and outages: each card is about one maker. */
const SIGHTINGS = new Set(["github", "pages", "arena", "training", "incidents", "packages", "apps", "web", "resets"]);

/** What the observation means for someone deciding whether to care. */
function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  if (event.stream === "training")
    return record?.ended
      ? "The training run is over, which is the step before a release. Nothing is announced yet."
      : "A training run in public, before any release or announcement.";
  // A first Arena sighting already says this in its own words; repeating it costs a line.
  if (event.stream === "arena" && event.kind !== "new")
    return record?.selectable === false
      ? "Visible on Arena, but not selectable yet."
      : "Visible and selectable on Arena.";
  if (event.stream === "resets") {
    if (record?.stage !== "Applied") {
      const when = typeof record?.expected === "string" ? ` Expected ${record.expected}.` : "";
      return record?.resetType === "banked"
        ? `A reset credit is promised.${when} Nothing has been credited yet.`
        : `A reset is promised.${when} Limits have not come back yet.`;
    }
    return record?.resetType === "banked"
      ? "A reset credit was granted; it applies to a later limit window."
      : "Usage limits are back for everyone.";
  }
  return null;
}

type Detail = "brief" | "evidence";

/** How sure the source is, in the words of someone who does not work here. */
export const TRUST: Record<string, string> = {
  observed: "unconfirmed",
  supported: "the maker's own words",
  confirmed: "confirmed by the provider",
  shipped: "out now",
};

/** A catalogue's name without its section: "Alibaba Model Studio API", "OpenRouter", "PyPI". */
function place(source: string): string {
  return sourceLabel(source).split(" · ")[0] ?? source;
}

type Incident = { icon: string; color: number };

/** An outage is read by its severity first: a red card for a major one, green once it is over. */
function incidentLook(event: Event, record: RecordData | null): Incident | null {
  if (event.stream !== "incidents") return null;
  const stage = String(record?.stage ?? "").toLowerCase();
  const impact = String(record?.impact ?? "").toLowerCase();
  if (event.kind === "removed" || ["resolved", "unlisted", "postmortem", "completed"].includes(stage))
    return { icon: "🟢", color: 0x2ecc71 };
  if (["critical", "major"].includes(impact)) return { icon: "🔴", color: 0xe74c3c };
  if (impact === "minor") return { icon: "🟠", color: 0xe67e22 };
  return { icon: "🟡", color: 0xf1c40f };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The first sentence or two of a published text, cut at a sentence rather than mid-word. */
function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  // A sentence ends at a stop followed by a space: "gpt-image-2.5-flare" is not two sentences.
  let kept = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (`${kept} ${sentence}`.trim().length > limit) break;
    kept = `${kept} ${sentence}`.trim();
  }
  return kept || `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** The rate a reader pays most, before and after, when it moved. */
function priceMove(
  event: Event,
  before: RecordData,
  after: RecordData,
): { from: number; to: number; field: string } | null {
  const old = (before.pricing ?? {}) as Record<string, unknown>;
  const next = (after.pricing ?? {}) as Record<string, unknown>;
  const key = ["completion", "output", "prompt", "input"].find((name) =>
    pricePair(old[name], next[name], event.source),
  );
  const pair = key ? pricePair(old[key], next[key], event.source) : null;
  if (!key || !pair || pair.from <= 0 || pair.from === pair.to) return null;
  return { ...pair, field: key === "completion" || key === "output" ? "output" : "input" };
}

/** "−30%", "+40%", "2×": how far a price moved, in the size a reader compares. */
function priceStep(from: number, to: number): string {
  if (to < from) return `−${Math.round((1 - to / from) * 100)}%`;
  const ratio = to / from;
  return ratio >= 1.95 ? `${Number(ratio.toFixed(1))}×` : `+${Math.round((ratio - 1) * 100)}%`;
}

/** "2× more expensive on OpenRouter", "30% cheaper on OpenRouter", from the rate a reader pays most. */
function priceSentence(event: Event, before: RecordData, after: RecordData): string | null {
  const move = priceMove(event, before, after);
  if (!move) return null;
  const where = place(event.source);
  const step = priceStep(move.from, move.to);
  if (move.to < move.from) return `${step.slice(1)} cheaper on ${where}.`;
  return step.endsWith("×") ? `${step} more expensive on ${where}.` : `${step.slice(1)} more expensive on ${where}.`;
}

const dollars = (value: number) => `$${Number(value.toFixed(value < 1 ? 3 : 2))}`;

/**
 * What a card says first, in one sentence, and which of its values stay. The facts are the record's;
 * this decides what a reader needs from them for each kind of thing that happened.
 */
function shape(
  event: Event & CardContext,
  before: RecordData | null,
  after: RecordData | null,
  vendor: string,
  facts: Fact[],
): { sentence: string | null; facts: Fact[] } {
  const record = after ?? before;
  const maker = vendor === "Unknown" ? null : vendor;
  const drop = (...labels: string[]) =>
    facts.filter((fact) => typeof fact === "string" || !labels.includes(fact.label));
  const catalogue = event.stream === "api-models" || event.stream === "openrouter";

  if (event.stream === "deprecations" && event.kind === "new" && after) {
    const shutdown = after.shutdown ?? after.retirement ?? after.deprecated;
    return {
      sentence: null,
      facts: [
        ...(present(after.announced) ? [{ label: "Announced", value: describe(after.announced) }] : []),
        { label: "Shutdown", value: present(shutdown) ? describe(shutdown) : "not announced" },
        { label: "Replacement", value: present(after.replacement) ? describe(after.replacement) : "not named" },
      ],
    };
  }
  if (event.stream === "incidents") {
    const summary = typeof record?.summary === "string" ? excerpt(record.summary, 200) : null;
    return {
      // The icon and stripe already say how bad it is, and a green one that it is over; "This incident
      // has been resolved" under a 🟢 said it a third time.
      // The icon says the status; what a closed one adds is how long it lasted, said as a sentence:
      // a "Lasted" field spent two lines on three words.
      sentence:
        event.kind === "removed" || /resolved/i.test(describe(after?.stage))
          ? (lasted(record, event) ?? (event.kind === "removed" ? "No longer listed on the status page." : null))
          : summary,
      facts: [],
    };
  }
  // The title says what and which version; a sentence under it only said where again.
  if (event.stream === "apps" && after) {
    return {
      sentence:
        event.kind === "new" && !present(after.version)
          ? `Released on ${place(event.source)}.`
          : present(after.version)
            ? null
            : `Updated on ${place(event.source)}.`,
      facts: [],
    };
  }
  if (event.stream === "packages") {
    return {
      sentence: event.kind === "removed" ? `Removed from ${place(event.source)}.` : null,
      facts: drop("Version", "Renamed"),
    };
  }
  // A reset's stage and type were fields under a sentence that already said both.
  if (event.stream === "resets") {
    // A promise with a time counts down on every reader's screen; Discord keeps the timer running.
    const due = resetDue(record);
    return {
      sentence:
        record?.stage === "Applied"
          ? resetConfirmation(record)
          : due !== null
            ? [resetWords(record), `Resets <t:${due}:R> · <t:${due}:t> your time.`].filter(Boolean).join("\n\n")
            : (resetWords(record) ?? readerImpact(event, record)),
      facts: [],
    };
  }
  if (event.stream === "news") {
    const text = [record?.summary, record?.description, record?.message].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    // A changelog arrives as its entries run together: "Added … Fixed … Added …". Three entries
    // read as a list; the rest is behind the link.
    const entries = text ? text.split(/\s+(?=(?:Added|Fixed|Improved|Changed|Removed|Updated|Deprecated) )/) : [];
    return {
      sentence:
        entries.length > 1
          ? entries
              .slice(0, 3)
              .map((entry) => `• ${excerpt(entry, 120)}`)
              .join("\n")
          : text
            ? excerpt(text, 280)
            : null,
      facts: facts.filter((fact) => typeof fact !== "string" && fact.label !== "Version"),
    };
  }
  if (event.stream === "weights" && event.kind === "new") {
    return {
      sentence: `Weights published on ${place(event.source)}.`,
      // `Qwen3_5MoeForConditionalGeneration` is a class name; a reader wants "Qwen3.5 MoE".
      facts: drop("Access", "Author", "Task", "Likes").map((fact) =>
        typeof fact !== "string" && fact.label === "Architecture"
          ? {
              ...fact,
              value: fact.value
                .replace(/For[A-Z]\w*$/, "")
                .replace(/(\d)_(\d)/g, "$1.$2")
                .replace(/Moe$/, " MoE"),
            }
          : fact,
      ),
    };
  }
  if (catalogue && before && after && JSON.stringify(before.pricing) !== JSON.stringify(after.pricing)) {
    return { sentence: priceSentence(event, before, after) ?? `Price changed on ${place(event.source)}.`, facts };
  }
  if (catalogue && event.kind === "new") {
    return {
      sentence: `Added to ${place(event.source)}.`,
      facts: drop("Owner", "Provider", "Maker"),
    };
  }
  if (catalogue && event.kind === "removed") return { sentence: `Removed from ${place(event.source)}.`, facts: [] };
  if (catalogue) return { sentence: `Changed on ${place(event.source)}.`, facts };
  if (event.stream === "web" && before && after) {
    const count = facts.find((fact) => typeof fact !== "string" && fact.label === "Changes");
    const [added, removed] = count && typeof count !== "string" ? (count.value.match(/\d+/g) ?? []) : [];
    const quotes = facts
      .filter((fact): fact is string => typeof fact === "string" && /^[+−] /.test(fact))
      .slice(0, 2)
      .map((line) => `> ${line}`);
    return {
      sentence: added !== undefined ? `${added} line${added === "1" ? "" : "s"} added, ${removed ?? 0} removed.` : null,
      facts: quotes,
    };
  }
  if (event.stream === "arena" && event.kind === "new" && !event.siblings?.length && !event.elsewhere?.length) {
    return {
      sentence: maker
        ? `Listed under ${maker}'s name. ${maker} has not announced it.`
        : "Unknown model on Arena. No maker is listed.",
      facts: drop("Identity"),
    };
  }
  if (event.stream === "leaderboards") return { sentence: null, facts };
  if (mentionSighting(event) && record) return { sentence: mentionSentence(record), facts: [] };
  const impact = readerImpact(event, record);
  // A changed arena row and an entry other catalogues already list say where they stand themselves.
  // A training run's footer already says "unconfirmed"; "Seen by one source, unconfirmed" said it twice.
  const standing =
    event.stream === "training" ||
    (event.stream === "arena" && (event.elsewhere?.length || event.siblings?.length || impact))
      ? null
      : readerStanding(event);
  return { sentence: [standing, impact].filter(Boolean).join(" ") || null, facts };
}

function lasted(record: RecordData | null, event: Event): string | null {
  const started = typeof record?.started === "string" ? Date.parse(record.started) : Number.NaN;
  const minutes = Math.round((Date.parse(event.detected_at) - started) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return `Lasted ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`}.`;
}

function present(raw: unknown): boolean {
  return !(raw === null || raw === undefined || raw === "");
}

/** What a news reader is spared: identity bookkeeping and the values only a scout checks. */
const EVIDENCE_ONLY = new Set(["Identity", "Also known as", "Variant", "Votes", "Architecture", "Provider", "Changes"]);

/** Discord shows at most 25 fields; a card with more than this many is a table nobody reads. */
const MAX_FIELDS = 6;
/** A value longer than this breaks a three-column row and gets the full width instead. */
const INLINE_CHARACTERS = 28;

/**
 * Labelled facts become the card's fields; sentences stay in the description. The fields follow the
 * facts' own order, and a fact past the field budget goes back into the text rather than away.
 */
function factLayout(facts: Fact[]): { lines: string[]; fields: Record<string, unknown>[] } {
  const lines: string[] = [];
  const fields: Record<string, unknown>[] = [];
  for (const fact of facts) {
    if (typeof fact === "string") lines.push(fact);
    else if (fields.length < MAX_FIELDS)
      fields.push({
        name: fact.label.slice(0, 256),
        value: fact.value.slice(0, 1024) || "—",
        inline: fact.value.length <= INLINE_CHARACTERS,
      });
    else lines.push(factText(fact));
  }
  return { lines, fields };
}

/** The source a card came from, and for a scout how sure that source is. */
export function footerText(source: string, confidence: string, detail: Detail, caveat?: string): string {
  return [
    sourceLabel(source),
    ...(detail === "evidence" ? [TRUST[confidence] ?? confidence] : []),
    ...(caveat ? [caveat] : []),
  ].join(" · ");
}

/**
 * A model its own maker has put in its own catalogue: the moment a release is real, and the card
 * that gets screenshotted. A reseller listing the same model is availability, not the launch.
 */
function isLaunch(event: Event, vendor: string): boolean {
  // A stealth model has no maker to put it in its own catalogue: whoever lists it first is the
  // launch, and the reader can call it that hour.
  if (isStealthLaunch(event)) return true;
  return (
    event.kind === "new" && event.stream === "api-models" && vendor !== "Unknown" && !listsAnotherMakersModel(event)
  );
}

/** The venue's name for a stealth model, capitalised as a model: `space-bunny-free` is Space Bunny. */
function stealthName(event: Event): string {
  return stealthSubject(event)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => (/^\d/.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

/**
 * What a stealth card is read for: that it is free, how much context it takes and what it accepts.
 * The venue's own bookkeeping -- a `headline` flag for its shop window, the family name already in
 * the title -- is not a fact about the model.
 */
const STEALTH_NOISE = new Set(["model", "maker", "free", "headline", "name", "id"]);

/**
 * Where a stealth model can be called, best venue first.
 *
 * Space Bunny reached OpenCode Go two seconds before Zen and the card named Go, which is the paid
 * client; Zen is the free endpoint, and free is the whole reason this is news. A reseller giving it
 * away comes next, and the rest of the venues go in the line underneath.
 */
const VENUE_ORDER = ["opencode-zen", "openrouter", "opencode-go"];

/**
 * What a stealth card is read for, in the order a reader weighs it: that it costs nothing, how much
 * it holds, and what it takes. Three pills is what the picture has room for.
 */
function stealthChips(event: Event & CardContext, found: readonly string[]): string[] {
  const borrowed = event.borrowed ?? {};
  const record = (event.after_json ? JSON.parse(event.after_json) : {}) as Record<string, unknown>;
  const context = found.find((chip) => chip.endsWith("context")) ?? contextChip(borrowed.context);
  const accepts = [record.input, borrowed.input].find(Array.isArray);
  return ["free", ...(context ? [context] : []), ...(accepts ? [accepts.join(", ")] : [])].slice(0, 3);
}

/**
 * The two numbers a launch is weighed by, filled in from another catalogue when the maker's own row
 * carries neither. Claude Opus 5.5 went out with an empty bottom half while OpenRouter held both.
 */
function launchChips(event: Event & CardContext, found: readonly string[]): string[] {
  const borrowed = event.borrowed ?? {};
  const chips = [...found];
  if (!chips.some((chip) => chip.endsWith("context"))) {
    const context = contextChip(borrowed.context);
    if (context) chips.push(context);
  }
  if (!chips.some((chip) => chip.includes("$"))) {
    const price = prices(null, borrowed.pricing, "openrouter").find(
      (fact): fact is Exclude<Fact, string> => typeof fact !== "string" && fact.label === "Price",
    );
    if (price) chips.push(priceChip(price.value));
  }
  return chips.slice(0, 3);
}

/** A borrowed context length as the picture says it: 1048576 tokens is "1M context". */
function contextChip(value: unknown): string | null {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 1000) return null;
  return `${tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}K`} context`;
}

/** The light on a card with no maker on it. */

/** "OpenCode Go and OpenRouter", the way a sentence lists places. */
function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function stealthVenues(event: Event & CardContext): { headline: string; others: string[]; source: string } {
  const sources = [...new Set([event.source, ...(event.elsewhere ?? [])])].sort((one, two) => {
    const rank = (source: string) => {
      const at = VENUE_ORDER.indexOf(source);
      return at === -1 ? VENUE_ORDER.length : at;
    };
    return rank(one) - rank(two);
  });
  const first = sources[0] ?? event.source;
  return { headline: place(first), others: sources.slice(1).map(place), source: first };
}

/** A price as a pill: the two rates a model is chosen by, without the unit the eyebrow implies. */
function priceChip(value: string): string {
  const trimmed = value.replace(/\s*\/\s*1M tokens$/, "");
  const rates = trimmed.split(" · ").filter((rate) => /\b(in|out)$/.test(rate));
  // A sheet with no in or out rate at all is quoted as it came rather than quoted as nothing.
  return rates.length ? rates.join(" · ") : trimmed;
}

/** Context and price, the two numbers a reader weighs a new model by, lifted out of the fields. */
function specLine(facts: Fact[]): { line: string | null; chips: string[]; rest: Fact[] } {
  const pick = (label: string) =>
    facts.find((fact): fact is Exclude<Fact, string> => typeof fact !== "string" && fact.label === label);
  const context = pick("Context");
  const price = pick("Price");
  const chips = [
    ...(context ? [`${context.value} context`] : []),
    // The picture holds three short pills. GPT-6 Sol's four rates ran off the edge of one; what a
    // reader weighs a model by is what it costs in and out, and the cache rates stay in the text.
    ...(price ? [priceChip(price.value)] : []),
  ];
  const line = [
    ...(context ? [`**${context.value}** context`] : []),
    ...(price ? [`**${price.value.replace(/\s*\/\s*1M tokens$/, "")}** per 1M tokens`] : []),
  ].join(" · ");
  return { line: line || null, chips, rest: facts.filter((fact) => fact !== context && fact !== price) };
}

/**
 * The banner's top line says what the card's title does not: when, and that it can be called. A
 * screenshot posted elsewhere loses Discord's timestamp, and the date on the picture is what shows
 * the news was early. "3 new models · Xiaomi" repeated the title word for word.
 */
function bannerEyebrow(vendor: string, detectedAt: string, where = "In the API"): string {
  return [vendor === "Unknown" ? null : vendor, where, shortDate(detectedAt, true)].filter(Boolean).join(" · ");
}

function shortDate(value: string, year = false): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** "Shutdown · in 23 days": how long is left is what a reader with the model in production needs. */
function shutdownCaption(day: string, from: string): string {
  const days = Math.round((Date.parse(day) - Date.parse(from)) / 86_400_000);
  return days > 0 ? `Shutdown · in ${days} day${days === 1 ? "" : "s"}` : "Shutdown";
}

/**
 * The picture for a card read for one number -- a debut's place, a price's move, a shutdown date --
 * so the number is what a screenshot shows first. Everything else keeps the plain card.
 */
function numberBanner(
  event: Event,
  before: RecordData | null,
  after: RecordData | null,
  vendor: string,
  name: string,
): Omit<Banner, "filename" | "logo"> | null {
  const base = { title: name, vendor };
  if (event.stream === "leaderboards" && event.kind === "new") {
    const rank = boardPlace(event);
    if (rank === null || rank > DEBUT_PLACES) return null;
    const board = place(event.source);
    // "text-to-image/overall" is a key; the caption under the place reads "Arena · text to image".
    const category =
      typeof after?.category === "string"
        ? after.category
            .replace(/\/overall$/, "")
            .replace(/[-_/]+/g, " ")
            .trim() || null
        : null;
    return {
      ...base,
      eyebrow: bannerEyebrow(vendor, event.detected_at, "Debut"),
      chips: [after?.score, after?.rating]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .slice(0, 1)
        .map((value) => `Score ${Math.round(value)}`),
      hero: {
        text: `#${rank}`,
        caption: [board, category].filter(Boolean).join(" · "),
        color: rank === 1 ? 0xf5c451 : 0xffffff,
      },
    };
  }
  if ((event.stream === "api-models" || event.stream === "openrouter") && before && after) {
    const move = priceMove(event, before, after);
    if (!move) return null;
    return {
      ...base,
      eyebrow: bannerEyebrow(vendor, event.detected_at, `Price on ${place(event.source)}`),
      chips: [`${dollars(move.from)} → ${dollars(move.to)} per 1M ${move.field}`],
      hero: {
        text: priceStep(move.from, move.to),
        caption: move.to < move.from ? "cheaper" : "dearer",
        color: move.to < move.from ? 0x3ddc84 : 0xff5c5c,
      },
    };
  }
  if (event.stream === "deprecations" && event.kind === "new" && after) {
    const shutdown = after.shutdown ?? after.retirement ?? after.deprecated;
    const day = typeof shutdown === "string" && !Number.isNaN(Date.parse(shutdown)) ? shutdown : null;
    if (!day) return null;
    return {
      ...base,
      // Two dates on one picture read as one: the top line says which is the announcement.
      eyebrow: [vendor === "Unknown" ? null : vendor, `Announced ${shortDate(event.detected_at)}`]
        .filter(Boolean)
        .join(" · "),
      chips: present(after.replacement)
        ? [`Replaced by ${displayTitle(describe(after.replacement), "api-models", event.source)}`]
        : [],
      hero: { text: shortDate(day), caption: shutdownCaption(day, event.detected_at), color: 0xffa94d },
    };
  }
  return null;
}

/**
 * The confirmed reset in the announcer's own words: "Reset all propagated. Sweet dreams." is the
 * line people repost, so the card quotes it and names who said it rather than paraphrasing it.
 */
/**
 * The people who announce resets, by their X handle: the name a reader knows them by and the photo
 * that sits in the corner, since a reset is his word before it is anything else.
 */
const ANNOUNCERS: Record<string, { name: string; photo: string }> = {
  thsottiaux: { name: "Tibo, Codex at OpenAI", photo: "thsottiaux.png" },
};

const resetAuthor = (record: RecordData | null) =>
  typeof record?.announcement === "string" ? record.announcement.match(/@(\w+)/)?.[1] : undefined;

/** The announcer's own words, big enough to read in a screenshot, with who said them under. */
const resetPost = (record: RecordData | null) =>
  typeof record?.summary === "string" ? record.summary.replace(/https:\/\/t\.co\/\S+/g, "").trim() : "";

function resetWords(record: RecordData | null): string | null {
  const post = resetPost(record);
  const author = resetAuthor(record);
  if (!post || !record) return null;
  const quote = excerpt(post, 280)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `### ${line}`)
    .join("\n");
  if (!author) return quote;
  return `${quote}\n— [${ANNOUNCERS[author]?.name ?? `@${author}`}](https://x.com/${author})`;
}

function resetConfirmation(record: RecordData): string {
  return resetWords(record) ?? "Seen by the tracker without a post. Usage limits are back.";
}

/** When a promised reset is due, if the tracker knows: "2026-09-22 18:00 UTC" as a Unix second. */
function resetDue(record: RecordData | null): number | null {
  if (record?.stage === "Applied" || typeof record?.expected !== "string") return null;
  const at = Date.parse(record.expected.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

const bannerName = (key: string) =>
  `banner-${key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)}.png`;

export function eventEmbed(
  event: Event & CardContext,
  url: string,
  summary?: string,
  detail: Detail = "evidence",
): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const link =
    typeof record?.url === "string" && record.url.trim()
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  const vendor = vendorOf(event, record);
  const rawName = String(record?.name ?? event.entity_id);
  const shown = displayTitle(rawName, event.stream, event.source);
  const stripped = withoutMakerPrefix(shown);
  const named = stripped === shown ? shown : capital(stripped);
  const untouchedName = withUntrackedMaker(named, vendor, record);
  const all = eventFactParts(event).filter((fact) => factText(fact).toLowerCase() !== `maker: ${vendor.toLowerCase()}`);
  const shaped = shape(event, before, after, vendor, all);
  const facts = shaped.facts.filter(
    (fact) =>
      detail === "evidence" || (typeof fact === "string" ? !/^> [+−] /.test(fact) : !EVIDENCE_ONLY.has(fact.label)),
  );
  const launch = isLaunch(event, vendor);
  const stealth = isStealthLaunch(event);
  // The venue spells a stealth model `space-bunny-free` and `stealth/space-bunny-alpha`; the model
  // is Space Bunny, and the spelling stays in the handle underneath for copying.
  const name = stealth ? stealthName(event) : untouchedName;
  const newModel = event.kind === "new" && MODEL_STREAMS.has(event.stream);
  const spec = newModel
    ? specLine(
        stealth
          ? facts.filter((fact) => typeof fact === "string" || !STEALTH_NOISE.has(fact.label.toLowerCase()))
          : facts,
      )
    : { line: null, chips: [], rest: facts };
  const venues = stealthVenues(event);
  if (launch && !stealth) spec.chips = launchChips(event, spec.chips);
  if (stealth) {
    // The picture carries what the model is; the text carries only what the picture cannot, which
    // is where to call it and what to type. The first card said "free" three times over.
    spec.chips = stealthChips(event, spec.chips);
    spec.line = null;
    spec.rest = [];
  }
  const { lines, fields } = factLayout(spec.rest);
  // The name a developer copies into an API call: on every new model, and for a scout whenever the
  // headline prettified it.
  const bareId = String(record?.id ?? event.entity_id);
  const handle =
    event.stream === "training" || event.stream === "resets"
      ? null
      : newModel && !/\s/.test(bareId)
        ? `\`${bareId}\``
        : detail === "evidence" &&
            rawName !== name &&
            !/\s/.test(rawName) &&
            event.stream !== "packages" &&
            !mentionSighting(event)
          ? `\`${rawName}\``
          : null;
  // A new model's title already says where it appeared, and the footer says it again.
  const sentence = newModel && /^Added to /.test(shaped.sentence ?? "") ? null : shaped.sentence;
  const alsoOn = stealth && venues.others.length ? `Also on ${listed(venues.others)}` : null;
  const description = [
    ...(summary ? [`*${summary}*`] : []),
    ...(alsoOn ? [alsoOn] : []),
    ...(sentence ? [sentence] : []),
    ...(spec.line ? [spec.line] : []),
    ...lines,
    ...(handle ? [handle] : []),
  ]
    .join("\n")
    .slice(0, DESCRIPTION_CHARACTERS);
  const incident = incidentLook(event, record);
  const color = cardColor({
    incident: incident?.color,
    stream: event.stream,
    kind: event.kind,
    stealth,
    vendor,
    branded:
      (event.kind === "new" && (MODEL_STREAMS.has(event.stream) || SIGHTINGS.has(event.stream))) ||
      (event.kind === "changed" && SIGHTINGS.has(event.stream)),
    applied: record?.stage === "Applied",
  });
  const sourceIcon = sourceLogo(event.source);
  const embed: Record<string, unknown> = {
    // A new model's title and banner name the maker and the moment; an eyebrow would say it a third time.
    // A sighting's maker is its logo in the corner; "REPOSITORY · OPENAI" above it named our feed
    // and the maker again. The eyebrow stays where there is no logo to say who.
    ...(newModel || (SIGHTINGS.has(event.stream) && vendorLogo(vendor))
      ? {}
      : {
          author: {
            name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
            ...(sourceIcon ? { icon_url: sourceIcon } : {}),
          },
        }),
    title: (stealth
      ? `🚀 ${name} is out — free on ${venues.headline}`
      : launch
        ? `🚀 ${name} is out`
        : newModel && event.stream !== "weights"
          ? `🆕 ${name} on ${place(event.source)}`
          : eventHeadline(event, name, incident)
    ).slice(0, 250),
    color,
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    // Discord renders its own timestamp in the reader's timezone, which is one line of card spent
    // on something the client already does.
    timestamp: new Date(event.detected_at).toISOString(),
    footer: {
      text: footerText(
        stealth ? venues.source : event.source,
        event.confidence ?? "observed",
        // A maker's own status page is not a rumour; "unconfirmed" under it read as doubt about the outage.
        // A sighting's emoji and sentence already say nobody has announced it.
        SIGHTINGS.has(event.stream) ? "brief" : detail,
        event.stream === "web" ? "not shipped yet" : undefined,
      ),
    },
  };
  const logo = vendorLogo(vendor)?.slice("attachment://".length) ?? null;
  // A reset, promised or confirmed, shows the person who announced it rather than the maker's tile.
  const announcer = event.stream === "resets" ? ANNOUNCERS[resetAuthor(after) ?? ""] : undefined;
  const thumbnail = announcer ? `attachment://${announcer.photo}` : logo ? `attachment://${logo}` : null;
  const words: Omit<Banner, "filename" | "logo"> | null = stealth
    ? {
        // No maker to name, so the picture says what it is instead: unclaimed, free, and where.
        // The title says where it is free; the picture says what the title cannot, which is that
        // nobody has put their name on it and what day it appeared.
        eyebrow: ["Stealth launch", shortDate(event.detected_at, true)].join(" · "),
        title: name,
        chips: spec.chips,
        vendor,
        glow: color,
      }
    : launch
      ? { eyebrow: bannerEyebrow(vendor, event.detected_at), title: name, chips: spec.chips, vendor, glow: color }
      : numberBanner(event, before, after, vendor, name);
  const post = announcer ? resetPost(after) : "";
  if (announcer && after && post) {
    // A reset is a person's word: the post is the picture, and the card under it keeps what a picture
    // cannot, the timer that counts down on every screen and the link to who said it.
    const applied = after.stage === "Applied";
    const due = resetDue(after);
    const day = new Date(event.detected_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const banner: Banner = {
      eyebrow: `Codex · ${applied ? "limits are back" : "reset announced"} · ${day}`,
      title: excerpt(post.replace(/\s+/g, " "), 140),
      chips: [],
      vendor,
      filename: bannerName(`${event.source}-${event.entity_id}-${applied ? "applied" : "announced"}`),
      logo: null,
      quote: {
        by: announcer.name,
        portrait: announcer.photo,
        ...(due !== null ? { due } : {}),
        ...(applied ? { accent: 0x3ddc84 } : {}),
      },
    };
    // The picture names who said it and the title links to the post, so the text keeps only the
    // timer, which Discord counts down in each reader's own time.
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
    if (due !== null) embed.description = `Resets <t:${due}:R> · <t:${due}:t> your time.`;
    else delete embed.description;
  } else if (words) {
    const banner: Banner = { ...words, filename: bannerName(`${event.source}-${event.entity_id}`), logo };
    // The banner carries the maker's tile, so the corner stays empty rather than showing it twice.
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
    if (!launch) trimToBanner(embed, banner, handle, event.source);
  } else if (thumbnail && (description || fields.length)) embed.thumbnail = { url: thumbnail };
  // A title alone beside a logo left a logo-high empty card above; the stripe says whose it is.
  if (link) embed.url = link;
  return embed;
}

/**
 * A card whose picture carries its number says nothing else: the first debut card said #1 four times
 * -- eyebrow, title, a sentence and the banner -- and a price card quoted its move three. What stays
 * is the title to click, the ID to copy and the source; the stripe takes the number's colour.
 */
function trimToBanner(embed: Record<string, unknown>, banner: Banner, handle: string | null, source: string): void {
  delete embed.author;
  // "Arena · leaderboards" names our feed; the reader wants the place, as a price card's "OpenRouter".
  const footer = embed.footer as { text: string };
  footer.text = footer.text.replace(sourceLabel(source), place(source));
  delete embed.fields;
  if (handle) embed.description = handle;
  else delete embed.description;
  const hero = banner.hero;
  if (!hero) return;
  if (hero.caption === "cheaper" || hero.caption === "dearer") {
    const step = hero.text.replace(/^[−+]/, "");
    embed.title = `${hero.caption === "cheaper" ? "💸" : "📈"} ${banner.title} is ${step} ${hero.caption === "cheaper" ? "cheaper" : "dearer"}`;
  }
  embed.color =
    hero.color === 0xffffff || hero.color === 0xf5c451 ? (vendorColor(banner.vendor) ?? embed.color) : hero.color;
  // The number decides the colour, so the picture is lit by it rather than by the maker's brand.
  banner.glow = embed.color as number;
}

/** The words two names share at the start: "MiMo V2.6" of "MiMo V2.6 Flash" and "MiMo V2.6 Pro". */
function sharedStem(names: string[]): string {
  const split = names.map((name) => name.split(/\s+/));
  const stem: string[] = [];
  for (const [index, word] of (split[0] ?? []).entries()) {
    if (split.every((words) => words[index]?.toLowerCase() === word.toLowerCase())) stem.push(word);
    else break;
  }
  return stem.join(" ");
}

/**
 * Several models arriving together, as one card: "3 new Xiaomi models" with a line for each.
 *
 * On 2026-09-21 Xiaomi's API listed MiMo V2.6 Flash, Pro and Pro Ultraspeed in one poll. The message
 * carried three cards, but all three linked to the same catalogue page and Discord folds embeds that
 * share a link into the first, so the channel showed Flash alone under "3 updates". A launch of a
 * family is one piece of news, and a card that lists it is also the one worth a screenshot.
 */
export function rosterEmbed(
  events: (Event & CardContext & { url: string })[],
  detail: Detail = "evidence",
): Record<string, unknown> {
  const cards = events.map((event) => eventEmbed(event, event.url, undefined, detail));
  const first = events[0] as Event & { url: string };
  const record = first.after_json ? (JSON.parse(first.after_json) as RecordData) : null;
  const vendor = vendorOf(first, record);
  const maker = vendor === "Unknown" ? null : vendor;
  const lines = cards.map((card, index) => {
    const event = events[index] as Event;
    const title = String(card.title ?? "")
      .replace(/^\S+\s+/, "")
      .replace(/ (?:is out|on .+)$/, "");
    const spec =
      typeof card.description === "string" ? /^\*\*.+ context.*$|^\*\*.+per 1M tokens$/m.exec(card.description) : null;
    const fields = ((card.fields ?? []) as { name: string; value: string }[])
      .filter((field) => !EVIDENCE_ONLY.has(field.name))
      .slice(0, 3)
      .map((field) => `${field.name} ${field.value}`);
    const id = event.entity_id.split("/").at(-1) ?? event.entity_id;
    // `mimo-v2.6-pro` says "MiMo V2.6 Pro" already; a name is shown only when it tells more.
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, "");
    const named = /\s/.test(id) || plain(title) !== plain(id);
    const link = typeof card.url === "string" && card.url !== first.url ? `[${title}](${card.url})` : title;
    const head = /\s/.test(id) ? `**${link}**` : named ? `**${link}** · \`${id}\`` : `\`${id}\``;
    const under = [...(spec ? [spec[0].replace(/\*\*/g, "")] : []), ...fields];
    return [head, ...under].join(" · ");
  });
  const embed: Record<string, unknown> = {
    title: `🚀 ${events.length} new ${maker ? `${maker} ` : ""}models`,
    color: cardColor({ stream: first.stream, kind: "new", vendor, branded: true }),
    description: clipLines(lines, DESCRIPTION_CHARACTERS),
    timestamp: new Date(first.detected_at).toISOString(),
    footer: { text: footerText(first.source, first.confidence ?? "observed", detail) },
  };
  const thumbnail = vendorLogo(vendor);
  if (maker && isLaunch(first, vendor)) {
    const names = cards.map((card) =>
      String(card.title ?? "")
        .replace(/^\S+\s+/, "")
        .replace(/ is out$/, ""),
    );
    const stem = sharedStem(names);
    const banner: Banner = {
      filename: bannerName(`${first.source}-${first.entity_id}-roster`),
      eyebrow: bannerEyebrow(maker, first.detected_at),
      title: stem || `${events.length} new models`,
      chips: names.map((name) => (stem ? name.slice(stem.length).trim() : name) || name),
      vendor,
      logo: thumbnail ? thumbnail.slice("attachment://".length) : null,
    };
    embed.image = { url: `attachment://${banner.filename}` };
    embed.banner = banner;
  } else if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (first.url) embed.url = first.url;
  return embed;
}

/** Whole lines up to the limit: a model's line is never cut in half. */
function clipLines(lines: string[], limit: number): string {
  let kept = "";
  for (const line of lines) {
    if (`${kept}\n${line}`.length > limit) break;
    kept = kept ? `${kept}\n${line}` : line;
  }
  return kept;
}

/**
 * A message of cards where each is one new model by one maker from the same catalogue reads as one
 * roster. Two makers on a reseller's list are two stories, and past eight names a list is a wall.
 */
export function isRoster(events: readonly Event[]): boolean {
  const first = events[0];
  if (!first || events.length < 2 || events.length > MAX_ROSTER) return false;
  const maker = (event: Event) =>
    vendorOf(event, event.after_json ? (JSON.parse(event.after_json) as RecordData) : null);
  const vendor = maker(first);
  return (
    vendor !== "Unknown" &&
    events.every(
      (event) =>
        event.kind === "new" &&
        MODEL_STREAMS.has(event.stream) &&
        event.source === first.source &&
        maker(event) === vendor,
    )
  );
}

const MAX_ROSTER = 8;
