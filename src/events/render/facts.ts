import { sourceLabel } from "../../sources/labels.js";
import { canonical } from "../canonical.js";
import { identityFor, normalizeIdentity } from "../identity.js";
import { SUBSTANTIVE_FIELDS } from "../oscillation.js";
import type { Event, RecordData } from "../types.js";
import { vendorOfName } from "../vendors.js";
import {
  collapseDetails,
  compactCount,
  describe,
  type Fact,
  factText,
  fieldLabels,
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

const COUNT_FIELDS = new Set(["context", "inputTokenLimit", "outputTokenLimit", "votes"]);
const ZERO_IS_BLANK = new Set(["context", "input", "output", "inputTokenLimit", "outputTokenLimit", "parameters"]);
/** An Elo score arrives as 1507.164171675996. Nobody reads past the first decimal. */
const SCORE_FIELDS = new Set(["score", "scoreUpper", "scoreLower"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function value(key: string, raw: unknown): string {
  if (COUNT_FIELDS.has(key)) return compactCount(raw);
  if (SCORE_FIELDS.has(key) && typeof raw === "number" && Number.isFinite(raw)) return raw.toFixed(1);
  return describe(raw);
}

function field(key: string, raw: unknown): Fact {
  return { label: fieldLabels[key] ?? key, value: value(key, raw) };
}

function transition(key: string, before: unknown, after: unknown): Fact {
  // A value that appears for the first time is the value; "not set → hidream" is a line spent on a blank.
  if (!present(before)) return { label: fieldLabels[key] ?? key, value: value(key, after) };
  return {
    label: fieldLabels[key] ?? key,
    value: `${value(key, before)} → ${present(after) ? value(key, after) : "—"}`,
  };
}

/** `{ text: true, image: true }` → `{ web: true }` reads as "Text, Image → Web". */
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
  if (!from.length && !to.length) return null;
  return `${from.join(", ") || "?"} → ${to.join(", ") || "?"}`;
}

/** An observation with no value is not worth a line of its own when nothing preceded it. */
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
  if (!aliases.length) return null;
  return { label: "Also known as", value: aliases.join(", ") };
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
  siblings?: Record<string, unknown>[];
};

/**
 * What sets a new roster entry apart from the entries already listed under its name. Only a value
 * that differs from every one of them is a difference; the rest is what they have in common.
 */
function siblingFacts(record: RecordData, siblings: Record<string, unknown>[]): Fact[] {
  const names = siblings.map((sibling) => `\`${String(sibling.name)}\``).join(", ");
  const facts: Fact[] = [`A separate entry from ${names}`];
  const differs = (read: (row: Record<string, unknown>) => string) => {
    const mine = read(record);
    const theirs = [...new Set(siblings.map(read))];
    return theirs.every((other) => other !== mine) ? `${mine} · others: ${theirs.join(" / ")}` : null;
  };
  const provider = differs((row) => (present(row.provider) ? describe(row.provider) : "none"));
  if (provider) facts.push({ label: "Provider", value: provider });
  const kinds = differs((row) => modalities(row.input, row.output) ?? "none");
  if (kinds) facts.push({ label: "Modalities", value: kinds });
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

export function eventFactParts(event: Event & CardContext, summary?: string): Fact[] {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const title = String(record?.name ?? event.entity_id);
  const lines: Fact[] = [];
  if (event.lead) lines.push(leadLine(event.lead, title));
  if (event.elsewhere) lines.push(elsewhereLine(event.elsewhere));

  if (event.returned && after && event.kind === "new") {
    const terms = (row: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(SUBSTANTIVE_FIELDS.map((field) => [field, row[field] ?? null])));
    const moved = eventFactParts({
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
    const { added, removed, meaningfulAdded, meaningfulRemoved } = webStringChanges(before.strings, after.strings);
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
    // said it twice in two wordings read like a machine talking to itself.
    lines.push("A public text change is not yet confirmation that a feature shipped.");
  } else if (event.stream === "arena" && before && after && before.name !== after.name) {
    lines.push({ label: "Renamed", value: `${describe(before.name)} → ${describe(after.name)}` });
    if (after.maker && after.maker !== before.maker)
      lines.push({ label: "Identified as", value: describe(after.maker) });
    if (canonical(before.selectable) !== canonical(after.selectable))
      lines.push(transition("selectable", before.selectable, after.selectable));
    if (canonical(before.input) !== canonical(after.input) || canonical(before.output) !== canonical(after.output)) {
      const was = modalities(before.input, before.output);
      const now = modalities(after.input, after.output);
      if (now) lines.push({ label: "Modalities", value: was ? `${was} ⇒ ${now}` : now });
    }
  } else if (event.stream === "arena" && !before && after) {
    if (after.selectable === false)
      lines.push("Hidden from the model picker — usually a model being tested before announcement");
    const apart = event.siblings?.length ? siblingFacts(after, event.siblings) : [];
    lines.push(...apart);
    lines.push({ label: "Pickable", value: after.selectable === false ? "No" : "Yes" });
    const kinds = modalities(after.input, after.output);
    if (kinds && !apart.some((fact) => typeof fact !== "string" && fact.label === "Modalities"))
      lines.push({ label: "Modalities", value: kinds });
    if (present(after.model) && canonical(after.model) !== canonical(after.name))
      lines.push(field("model", after.model));
  } else if (event.stream === "leaderboards" && !before && after) {
    lines.push(
      after.rank
        ? `Enters ${describe(after.category)} at rank ${describe(after.rank)}`
        : `Enters ${describe(after.category)}, outside the leading places`,
    );
    for (const key of ["score", "modelKey", "votes"]) if (present(after[key])) lines.push(field(key, after[key]));
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
        if (added.length) lines.push({ label: fieldLabels[key] ?? key, value: `+ ${describe(added)}` });
        if (removed.length) lines.push({ label: fieldLabels[key] ?? key, value: `− ${describe(removed)}` });
        continue;
      }
      lines.push(transition(key, before[key], after[key]));
    }
  } else {
    for (const [key, raw] of Object.entries(record ?? {})) {
      if (key === "id" || key === "name" || key === "prerelease" || NOISE.has(key)) continue;
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
      // Whether a listing can be used is stated as a sentence, not as "Selectable: yes". A maker
      // that repeats the provider is one line spent on nothing.
      if (key === "selectable") continue;
      if (key === "maker" && canonical(raw) === canonical(record?.provider)) continue;
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

  const collapsed = collapseDetails(lines);
  // A model a catalogue already sells is not an unconfirmed name, whatever the arena calls it.
  const identity =
    (event.stream === "arena" || event.stream === "leaderboards") && !event.elsewhere?.length
      ? identityLine(event, record, title)
      : null;
  return [...(summary ? [{ label: "AI summary", value: summary }] : []), ...collapsed, ...(identity ? [identity] : [])];
}
