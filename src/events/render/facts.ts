import { sourceLabel } from "../../sources/labels.js";
import { canonical } from "../canonical.js";
import { identityFor, normalizeIdentity } from "../identity.js";
import { readableName } from "../naming.js";
import { SUBSTANTIVE_FIELDS } from "../oscillation.js";
import { isStealthLaunch } from "../resellers.js";
import type { Event, RecordData } from "../types.js";
import { vendorOfName } from "../vendors.js";
import { saysItShipped, tellingWebString } from "../web.js";
import {
  collapseDetails,
  compactCount,
  describe,
  type Fact,
  factText,
  fieldLabel,
  githubChangeStats,
  NOISE,
  prices,
  rankMove,
  webStringChanges,
} from "./common.js";

/**
 * The facts of one event, as reader-facing lines.
 *
 * Every transport renders the same lines. Telegram wraps them in a header and a footer, Discord
 * puts them in an embed description, and the notification policy asks whether there are any. They
 * used to be recovered by slicing a rendered Telegram message at fixed offsets, so one added line
 * silently changed what Discord showed and what counted as an empty message.
 */

/**
 * A token count, written the way a reader counts: `maxOutputTokens` is the gateways' spelling of
 * `outputTokenLimit` and was in neither this set nor `ZERO_IS_BLANK`, so a Vercel row printed
 * "Output token limit 256000" beside a context already written as 256K, and a row that named no
 * limit printed "Output token limit 0".
 */
const COUNT_FIELDS = new Set([
  "context",
  "inputTokenLimit",
  "maxOutput",
  "maxOutputTokens",
  "outputTokenLimit",
  "votes",
]);
/**
 * The capability matrix a maker publishes, which is a diff and never a debut.
 *
 * Anthropic's `/v1/models` answers with every capability, every effort level, every dated
 * context-management feature and every thinking type, and reading them is what makes a model
 * gaining `effort.xhigh` visible at all -- before it, 7,303 collections over thirty days raised one
 * event. That is worth having and it is worth having on the card that reports the gain, where the
 * list is the whole story.
 *
 * On an arrival it is not the story. Claude Haiku 5.5 went out on 2026-10-07 under six fields and
 * twenty-two values, of which a reader decides on two; the launch before it, Opus 5.5, said the
 * name and the window and drew more of a room than its successor did. A debut card answers what the
 * model is, and the matrix answers what it supports, which is a question nobody has yet asked.
 *
 * Dropped from the card only. Every value stays in the record, stays in the evidence, and arrives
 * in full the first time one of them moves.
 */
const MATRIX_FIELDS = new Set(["capabilities", "contextManagement", "effortLevels", "thinkingTypes"]);
const ZERO_IS_BLANK = new Set([
  "context",
  "input",
  "output",
  "inputTokenLimit",
  "maxOutputTokens",
  "outputTokenLimit",
  "parameters",
]);
/** An Elo score arrives as 1507.164171675996. Nobody reads past the first decimal. */
const SCORE_FIELDS = new Set(["score", "scoreUpper", "scoreLower"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function value(key: string, raw: unknown): string {
  if (COUNT_FIELDS.has(key)) return compactCount(raw);
  if (SCORE_FIELDS.has(key) && typeof raw === "number" && Number.isFinite(raw)) return raw.toFixed(1);
  return describe(raw);
}

function field(key: string, raw: unknown): Fact {
  return { label: fieldLabel(key), value: value(key, raw) };
}

function transition(key: string, before: unknown, after: unknown): Fact {
  // A value that appears for the first time is the value; "not set → hidream" is a line spent on a blank.
  if (!present(before)) return { label: fieldLabel(key), value: value(key, after) };
  if (!present(after)) return { label: fieldLabel(key), value: `${value(key, before)} → —` };
  /**
   * A count is written in whatever spelling still shows it moved.
   *
   * A rounded count is the right thing to read until it is both sides of an arrow: models.dev took
   * DeepSeek Pro Latest from 384000 to 393216 and the card said "384K → 384K", which is a card
   * reporting that nothing happened. The exact numbers are the fallback rather than the rule, so
   * "1M → 2M" stays as it is and only the move a rounding hides spells itself out.
   *
   * Counts only. A score rounds for a different reason -- 1507.164171675996 is a precision the
   * board publishes and nobody reads -- and a board that moved a model by a hundredth is the case
   * that rounding is there to swallow, not a move to spell out in fifteen digits.
   */
  const rounded = [value(key, before), value(key, after)];
  const exact = rounded[0] === rounded[1] && COUNT_FIELDS.has(key) ? [describe(before), describe(after)] : rounded;
  return { label: fieldLabel(key), value: `${exact[0]} → ${exact[1]}` };
}

/** `{ text: true, image: true }` → `{ web: true }` reads as "Text, Image → Web". */
/**
 * What a model takes in and what it gives back, and nothing when the half that matters is unknown.
 *
 * The output side is the one a reader is deciding on: it is the difference between a coding model
 * and a picture model. A catalogue that lists only the input leaves that unanswered, and the line
 * used to print the gap as a question mark -- "Text → ?" under `flux-3-image` on 2026-10-06, a
 * field that spends two lines of a card to say we did not look. models.dev, which is most of our
 * coverage, publishes `input` and no `output` at all, so this was the common case rather than the
 * rare one.
 *
 * Saying nothing is honest and short, and it was all this could do while the answer was only held
 * elsewhere. `modalityLine` is the separate change that reaches it.
 */
function modalities(input: unknown, output: unknown): string | null {
  const names = (raw: unknown) =>
    (raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.entries(raw)
          .filter(([, on]) => on === true)
          .map(([name]) => name)
      : present(raw)
        ? [describe(raw)]
        : []
    ).map((name) => name.charAt(0).toUpperCase() + name.slice(1));
  const from = names(input);
  const to = names(output);
  if (!to.length) return null;
  return `${from.join(", ") || "?"} → ${to.join(", ")}`;
}

/**
 * The same line, with the half the venue does not carry read from a catalogue that does.
 *
 * `borrowed` is already how a card says what an empty row holds -- a context window, a price, what
 * the model accepts -- and `output` is already one of the fields it fetches. The line that needed
 * it most was the only reader not asking: the Arena lists what a model takes and not what it gives
 * back, models.dev is most of our coverage and publishes no `output` at all, and OpenRouter
 * publishes both for the same models minutes away. So the card had the answer in hand and printed
 * nothing. Unmarked, as the borrowed window and the borrowed input are: a second catalogue saying
 * what a model produces is not a claim anyone disputes.
 *
 * The maker's own row wins where it has anything to say, which is why this fills rather than
 * overrides -- and why a rename still compares the two rows it was given and not a third one.
 */
function modalityLine(event: Event & CardContext, record: Record<string, unknown>): string | null {
  const borrowed = event.borrowed ?? {};
  return modalities(
    present(record.input) ? record.input : borrowed.input,
    present(record.output) ? record.output : borrowed.output,
  );
}

/** An observation with no value is not worth a line of its own when nothing preceded it. */
/**
 * A leaderboard's category in the reader's words. The record keeps it as the key the board is
 * fetched by -- "artificial-analysis/quality", "designarena/uicomponent" -- and that key names our
 * own storage, not the thing measured.
 */
function boardWords(category: unknown, source: string): string {
  const key = typeof category === "string" ? category : "";
  const board = sourceLabel(source).split(" · ")[0] ?? source;
  const tail = (key.split("/").at(-1) ?? "").replace(/[-_]+/g, " ").trim();
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!tail || tail === "overall") return board;
  return plain(tail).includes(plain(board)) ? capitalWords(tail) : `${board} ${tail}`;
}

function capitalWords(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function present(raw: unknown): boolean {
  return !(raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0));
}

/**
 * Identity as a reader reads it. An internal UUID and a repetition of the title are not aliases
 * worth printing; an unresolved sighting says so in words.
 */
function identityLine(event: Event, record: RecordData | null, title: string): Fact | null {
  const identity = identityFor(event, record);
  if (identity.status === "canonical") return null;
  // `qwen-audio-3-0-tts-plus` beside the title `Qwen-Audio-3.0-TTS-Plus` is one name, not an alias.
  const aliases = identity.aliases.filter(
    (alias) => !UUID.test(alias) && normalizeIdentity(alias) !== normalizeIdentity(title) && alias.trim().length > 0,
  );
  if (identity.status === "unconfirmed" && !aliases.length) {
    // `gemini-3.8-flash` on the arena names its maker; what is unconfirmed is that the maker said so.
    // The arena's own maker field counts as much as the name: `gemini-3.8-flash` listed under google
    // read "Unidentified model." beside a GOOGLE eyebrow on 2026-09-17.
    const named = vendorOfName(title);
    const maker = named === "Unknown" && typeof record?.maker === "string" ? vendorOfName(record.maker) : named;
    return { label: "Identity", value: maker === "Unknown" ? "Unidentified" : `Unconfirmed by ${maker}` };
  }
  // `lina-f` beside `lina-f-alpha` is the same name shortened, not a second one.
  const distinct = aliases.filter((alias) => !normalizeIdentity(title).startsWith(normalizeIdentity(alias)));
  if (!distinct.length) return null;
  return { label: "Also known as", value: distinct.join(", ") };
}

/**
 * How long this story had already been visible somewhere else, and where.
 *
 * The whole point of watching eighty sources is that one of them speaks first, and a reader who is
 * told "the catalogue has it" learns nothing about that. A card that says the package registry
 * carried it seventeen hours earlier says what the service is for, in the only terms that can be
 * checked. It is only ever set from a source in a different family, so a collector seeing its own
 * record twice never reads as a lead.
 */
export type LeadTime = { hours: number; source: string; name?: string };

/**
 * What a card knows beyond its own event, looked up once per batch by the code that has the database.
 *
 * `returned` is the row as it last left, for a row that has come back changed. `elsewhere` names the
 * other catalogues and registries already carrying the model: "dashscope: glm-5.3" reached the wire
 * with no word that Z.ai and OpenRouter had listed GLM 5.3 before Alibaba's platform did, and a
 * reader deciding whether that is news needs exactly that.
 */
export type CardContext = {
  lead?: LeadTime;
  returned?: Record<string, unknown>;
  elsewhere?: string[];
  /** Facts about the model the venue itself does not carry, read from a catalogue that does. */
  borrowed?: Record<string, unknown>;
  siblings?: Record<string, unknown>[];
  /**
   * The maker's own announcement of this model, when this database holds one from before the
   * sighting. Absent means none was recorded, never that none was made: see `announcementsBySubject`.
   */
  announced?: { at: string; source: string };
};

/**
 * What sets a new roster entry apart from the entry it is most like: one with the same name, else the
 * first of its line. Naming every sibling and every modality they carry made a card nobody could
 * read; a reader wants one comparison and only the values that differ.
 */
function siblingFacts(
  record: RecordData,
  siblings: Record<string, unknown>[],
  released: boolean,
  title: string,
): Fact[] {
  const closest =
    siblings.find((sibling) => normalizeIdentity(String(sibling.name)) === normalizeIdentity(title)) ?? siblings[0];
  if (!closest) return [];
  const facts: Fact[] = [
    released
      ? `Another Arena entry for ${readableName(title)}, already out.`
      : normalizeIdentity(String(closest.name)) === normalizeIdentity(title)
        ? // #560 and #567 on 2026-09-18 announced an entry "beside" itself.
          "Another Arena entry under the same name."
        : `Another Arena entry beside \`${String(closest.name)}\`.`,
    { label: "Differs from", value: `\`${String(closest.name)}\`` },
  ];
  const names = (raw: unknown) =>
    raw && typeof raw === "object"
      ? Object.entries(raw)
          .filter(([, on]) => on === true)
          .map(([name]) => name.charAt(0).toUpperCase() + name.slice(1))
          .join(", ") || "none"
      : present(raw)
        ? describe(raw)
        : "none";
  for (const [label, read] of [
    ["Input", (row: Record<string, unknown>) => names(row.input)],
    ["Output", (row: Record<string, unknown>) => names(row.output)],
    ["Provider", (row: Record<string, unknown>) => names(row.provider)],
  ] as const) {
    const mine = read(record);
    const theirs = read(closest);
    if (mine !== theirs) facts.push({ label, value: `${mine} (was ${theirs})` });
  }
  return facts;
}

/** Where a model is tested under a name that is not its own. */
const CODENAME_SOURCES = /^(arena|arena-leaderboards|designarena:)/;

/**
 * The reveal. `spicy-mayo` sighted on the arena five days before a maker lists `Gemini 4 Ultra` is
 * the story the scouts were told the first half of; the launch card on the wire says the second half
 * points back to it, in the codename the room saw.
 */
function leadLine(lead: LeadTime, title: string): string {
  const amount = lead.hours < 48 ? `${Math.round(lead.hours)} hours` : `${Math.round(lead.hours / 24)} days`;
  const codename = lead.name && lead.name.toLowerCase() !== title.toLowerCase() ? lead.name : null;
  if (codename && CODENAME_SOURCES.test(lead.source))
    return `🕵 Sighted ${amount} earlier on ${sourceLabel(lead.source)} as \`${codename}\``;
  return `⏱ Seen ${amount} earlier on ${sourceLabel(lead.source)}`;
}

function elsewhereLine(sources: readonly string[]): string {
  return sources.length
    ? `Already out · listed by ${sources.map(sourceLabel).join(", ")}`
    : "No other tracked catalogue lists it yet";
}

export function eventFacts(event: Event & CardContext, summary?: string): string[] {
  return eventFactParts(event, summary).map(factText);
}

/** Two spellings of one handle: `provider-config` beside `microsoft-foundry/provider-config`. */
function sameHandle(value: unknown, handle: unknown): boolean {
  if (typeof value !== "string" || typeof handle !== "string" || !value) return false;
  const bare = (text: string) => (text.split("/").at(-1) ?? text).toLowerCase().replace(/[^a-z0-9]/g, "");
  return bare(value) === bare(handle);
}

/**
 * A window two catalogues answer differently, marked where a reader meets it.
 *
 * "512K" reads as a measurement; it was one catalogue's answer, and Mistral's own page, the Vercel
 * gateway and models.dev all said a million for the same model on the day it launched. The card
 * keeps the number the source it is reporting gave -- printing the other one would be quoting a
 * catalogue the event did not come from -- and puts a question mark on it, with the other reading
 * named underneath, so the number is still usable and no longer stated as settled.
 */
function contested(facts: Fact[], event: Event & CardContext): Fact[] {
  const theirs = event.borrowed?.contestedContext;
  if (typeof theirs !== "number") return facts;
  const by = sourceLabel(String(event.borrowed?.contestedBy ?? ""));
  return facts.flatMap((fact) =>
    typeof fact !== "string" && fact.label === "Context"
      ? [{ label: fact.label, value: `${fact.value}?` }, `${by} lists ${compactCount(theirs)} for the same model`]
      : [fact],
  );
}

export function eventFactParts(event: Event & CardContext, summary?: string): Fact[] {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const title = String(record?.name ?? event.entity_id);
  const lines: Fact[] = [];
  /**
   * Who was first is the story of an arrival; on a price moving it was a model seen twelve days
   * before its cache read got cheaper, which nobody reading asked.
   *
   * Held back to the end rather than pushed here, because it annotates the news instead of being
   * it. As the first line it was what a story card quoted -- `storyEmbed` takes each event's
   * opening fact -- so "Mistral Large 4 is out" arrived as "Seen 3 hours earlier on OpenRouter".
   */
  const lead = event.lead && event.kind !== "changed" ? leadLine(event.lead, title) : null;
  // A roster entry beside its own siblings says "already out" in its own sentence.
  const sibling = event.stream === "arena" && !before && Boolean(event.siblings?.length);
  // A stealth model is listed by several venues within the hour by design; the card names them in
  // one line of its own, and "no other tracked catalogue lists it yet" is never the story there.
  if (event.elsewhere && !(sibling && event.elsewhere.length) && !isStealthLaunch(event))
    lines.push(elsewhereLine(event.elsewhere));

  if (event.returned && after && event.kind === "new") {
    const terms = (row: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(SUBSTANTIVE_FIELDS.map((field) => [field, row[field] ?? null])));
    const moved = eventFactParts({
      signal: null,
      id: event.id,
      source: event.source,
      stream: event.stream,
      entity_id: event.entity_id,
      detected_at: event.detected_at,
      kind: "changed",
      before_json: terms(event.returned),
      after_json: terms(after),
    });
    if (moved.length) return [...lines, "Listed again, and not on the terms it left with:", ...moved];
  }

  if (event.stream === "web" && before && after && Array.isArray(before.strings) && Array.isArray(after.strings)) {
    const changes = webStringChanges(before.strings, after.strings);
    const { added, removed, meaningfulRemoved } = changes;
    // What names a model or a preview is what the card quotes first.
    const meaningfulAdded = [
      ...changes.meaningfulAdded.filter(tellingWebString),
      ...changes.meaningfulAdded.filter((value) => !tellingWebString(value)),
    ];
    lines.push({
      label: "Changes",
      value: `+${meaningfulAdded.length} / −${meaningfulRemoved.length} meaningful · ${added.length + removed.length} total`,
    });
    // Three strings are what a reader takes in at a glance; the full list travels as a file.
    const shownAdded = meaningfulAdded.slice(0, 2);
    const shownRemoved = meaningfulRemoved.slice(0, 1);
    lines.push(
      ...shownAdded.map((item) => `+ ${item.slice(0, 140)}`),
      ...shownRemoved.map((item) => `− ${item.slice(0, 140)}`),
    );
    const hidden = meaningfulAdded.length - shownAdded.length + (meaningfulRemoved.length - shownRemoved.length);
    if (hidden > 0) lines.push(`…and ${hidden} more material changes not shown`);
    if (!meaningfulAdded.length && !meaningfulRemoved.length) lines.push("No material user-facing text changed.");
    // The one place this caveat is written: every transport renders these lines, and a card that
    // said it twice in two wordings read like a machine talking to itself. It is not written at all
    // over a quote that says the thing is out; see `webChangeSaysItShipped`.
    if (!meaningfulAdded.some(saysItShipped))
      lines.push("A public text change is not yet confirmation that a feature shipped.");
  } else if (event.stream === "arena" && before && after && before.name !== after.name) {
    lines.push({ label: "Renamed", value: `${describe(before.name)} → ${describe(after.name)}` });
    if (after.maker && after.maker !== before.maker)
      lines.push({ label: "Identified as", value: describe(after.maker) });
    if (canonical(before.selectable) !== canonical(after.selectable))
      lines.push(transition("selectable", before.selectable, after.selectable));
    if (canonical(before.input) !== canonical(after.input) || canonical(before.output) !== canonical(after.output)) {
      const was = modalities(before.input, before.output);
      const now = modalityLine(event, after);
      if (now) lines.push({ label: "Modalities", value: was ? `${was} ⇒ ${now}` : now });
    }
  } else if (event.stream === "arena" && !before && after) {
    if (after.selectable === false)
      lines.push("Hidden from the model picker — usually a model being tested before announcement");
    if (event.siblings?.length)
      lines.push(...siblingFacts(after, event.siblings, Boolean(event.elsewhere?.length), title));
    else {
      // Pickable is the ordinary case; only its absence is worth a field.
      if (after.selectable === false) lines.push({ label: "Pickable", value: "No" });
      const kinds = modalityLine(event, after);
      if (kinds) lines.push({ label: "Modalities", value: kinds });
    }
    if (present(after.model) && canonical(after.model) !== canonical(after.name))
      lines.push(field("model", after.model));
  } else if (event.stream === "leaderboards" && !before && after) {
    // The board is named in words, not as the key we store it under: a debut card read "Enters
    // artificial-analysis/quality at rank 18", which is our own path printed at the reader.
    const board = boardWords(after.category, event.source);
    lines.push(after.rank ? `Enters ${board} at rank ${describe(after.rank)}` : `Enters ${board}, outside the top`);
    // The scores are an object of a dozen benchmarks, most of them unset. Spelled out they filled
    // eight lines with "aime: not set" and repeated, inside the mess, the one index already in the
    // title. The whole table lives in the evidence file instead.
    if (present(after.votes)) lines.push(field("votes", after.votes));
  } else if (event.stream === "leaderboards" && before && after) {
    if (canonical(before.category) !== canonical(after.category))
      lines.push({ label: "Benchmark", value: `${describe(before.category)} → ${describe(after.category)}` });
    else if (present(after.category) || present(before.category))
      lines.push({ label: "Benchmark", value: describe(after.category ?? before.category) });
    if (canonical(before.rank) !== canonical(after.rank)) {
      if (present(before.rank) && present(after.rank)) lines.push(rankMove(before.rank, after.rank));
      else if (present(before.rank)) lines.push(`Falls outside tracked top 20 (was rank ${describe(before.rank)})`);
      else if (present(after.rank)) lines.push(`Enters tracked top 20 at rank ${describe(after.rank)}`);
    }
    for (const key of ["score", "modelKey", "votes"])
      if (canonical(before[key]) !== canonical(after[key])) lines.push(transition(key, before[key], after[key]));
  } else if (event.stream === "leaderboards" && before && !after) {
    lines.push(`Leaves ${describe(before.category)}`);
    if (present(before.rank)) lines.push({ label: "Last observed rank", value: describe(before.rank) });
  } else if (event.stream === "training" && after) {
    // "mode live → ended" and an ISO instant were what the scouts read on 2026-09-19 for the most
    // useful thing this source can say: a run started, or a run finished.
    const day = (value: unknown) =>
      typeof value === "string" && Number.isFinite(Date.parse(value))
        ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })
        : null;
    const started = day(after.started);
    const ended = day(after.ended);
    // A run that started the day it is told has its start in the timestamp already.
    if (started && !ended && started !== day(new Date().toISOString()))
      lines.push({ label: "Started", value: started });
    else if (started && ended) lines.push({ label: "Started", value: started });
    if (ended) lines.push({ label: "Finished", value: ended });
    const days =
      typeof after.started === "string" && typeof after.ended === "string"
        ? Math.round((Date.parse(after.ended) - Date.parse(after.started)) / 86_400_000)
        : null;
    if (days !== null && days > 0) lines.push({ label: "Ran for", value: `${days} day${days === 1 ? "" : "s"}` });
  } else if (event.stream === "github") {
    if (record?.stage) lines.push(describe(record.stage));
    else if (event.source.endsWith(":commits")) lines.push("Repository change; not a release yet");
    else if (event.source.endsWith(":releases")) lines.push("Published release");
    if (record?.author)
      lines.push({ label: "Author", value: `${describe(record.author)} (${describe(record.association)})` });
    const stats =
      event.source.endsWith(":commits") || event.source.endsWith(":pulls") ? githubChangeStats(record?.summary) : null;
    if (stats) lines.push(stats);
    else if (record?.summary) lines.push(describe(record.summary));
  } else if (before && after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (NOISE.has(key) || canonical(before[key]) === canonical(after[key])) continue;
      if (key === "pricing") {
        lines.push(...prices(before[key], after[key], event.source));
        continue;
      }
      if (["summary", "description", "message"].includes(key)) {
        lines.push(describe(after[key]));
        continue;
      }
      if (key === "rank") {
        lines.push(rankMove(before[key], after[key]));
        continue;
      }
      // A reset's title already reads "announced" then "for everyone"; the stage line below says
      // the same move in the same card.
      if (key === "name" && event.stream === "resets") continue;
      if (key === "name") {
        // A package name carries its version, so "openai 3.12.0 → openai 3.13.0" and
        // "3.12.0 → 3.13.0" are the same sentence twice.
        if (canonical(before.version) === canonical(after.version))
          lines.push({ label: "Renamed", value: `${describe(before[key])} → ${describe(after[key])}` });
        continue;
      }
      if (key === "version") {
        lines.push(transition(key, before[key], after[key]));
        continue;
      }
      if (Array.isArray(before[key]) && Array.isArray(after[key])) {
        const old = before[key] as unknown[];
        const next = after[key] as unknown[];
        const added = next.filter((item) => !old.some((previous) => canonical(previous) === canonical(item)));
        const removed = old.filter((item) => !next.some((current) => canonical(current) === canonical(item)));
        if (added.length) lines.push({ label: fieldLabel(key), value: `+ ${describe(added)}` });
        if (removed.length) lines.push({ label: fieldLabel(key), value: `− ${describe(removed)}` });
        continue;
      }
      lines.push(transition(key, before[key], after[key]));
    }
  } else {
    for (const [key, raw] of Object.entries(record ?? {})) {
      if (key === "id" || key === "name" || key === "prerelease" || NOISE.has(key)) continue;
      // A field whose value is the model's own handle under another name. TrueFoundry's card for
      // `microsoft-foundry/provider-config` printed the handle in its description and then twice
      // more, as "canonical_id" and as "Model", because the catalogue keeps it under three keys.
      if (sameHandle(raw, record?.id) || sameHandle(raw, record?.name)) continue;
      // The full list of supported API parameters is retained evidence that no reader decides
      // anything from. When it changes, the added and removed entries are shown instead.
      if (key === "parameters" && typeof raw === "number") {
        lines.push({
          label: "Parameters",
          value: raw >= 1e9 ? `${(raw / 1e9).toFixed(raw >= 1e10 ? 0 : 1)}B` : compactCount(raw),
        });
        continue;
      }
      if (key === "parameters") continue;
      // The matrix is the news when it moves and clutter when it arrives; see MATRIX_FIELDS.
      if (MATRIX_FIELDS.has(key)) continue;
      // Whether a listing can be used is stated as a sentence, not as "Selectable: yes". A maker
      // that repeats the provider is one line spent on nothing.
      if (key === "selectable") continue;
      // The maker is on the card twice already -- in the line above the title and on the logo -- so
      // it is never a fact. Cursor's "Rollouts and Security Review" reached #signals on 2026-09-23
      // with "Maker: Cursor" as the only thing under its title, because the entry carried no other
      // field; a card with nothing to say says the title and stops.
      if (key === "maker") continue;
      if (key === "pricing") lines.push(...prices(null, raw, event.source));
      else if (["description", "summary", "message"].includes(key)) {
        // A feed that carries no summary for a post said nothing; "not set" is a line spent saying
        // that a field was empty, which is not a fact about the thing.
        if (present(raw)) lines.push(describe(raw));
      }
      // A field a source left empty is absence of evidence, not a fact about the model, and a count
      // of zero is the same blank written as a number: no model has a context window of 0.
      else if (present(raw) && !(ZERO_IS_BLANK.has(key) && Number(raw) === 0)) lines.push(field(key, raw));
    }
  }

  const collapsed = contested(collapseDetails(lines), event);
  // A model a catalogue already sells is not an unconfirmed name, whatever the arena calls it.
  const identity =
    (event.stream === "arena" || event.stream === "leaderboards") && !event.elsewhere?.length
      ? identityLine(event, record, title)
      : null;
  return [
    ...(summary ? [{ label: "AI summary", value: summary }] : []),
    ...collapsed,
    ...(lead ? [lead] : []),
    ...(identity ? [identity] : []),
  ];
}
