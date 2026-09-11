import { canonical } from "../canonical.js";
import { identityFor } from "../identity.js";
import type { Event, RecordData } from "../types.js";
import {
  collapseDetails,
  compactCount,
  describe,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function value(key: string, raw: unknown): string {
  return COUNT_FIELDS.has(key) ? compactCount(raw) : describe(raw);
}

function transition(key: string, before: unknown, after: unknown): string {
  return `${fieldLabels[key] ?? key}: ${value(key, before)} → ${value(key, after)}`;
}

/** An observation with no value is not worth a line of its own when nothing preceded it. */
function present(raw: unknown): boolean {
  return !(raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0));
}

/**
 * Identity as a reader reads it. An internal UUID and a repetition of the title are not aliases
 * worth printing; an unresolved sighting says so in words.
 */
function identityLine(event: Event, record: RecordData | null, title: string): string | null {
  const identity = identityFor(event, record);
  if (identity.status === "canonical") return null;
  const aliases = identity.aliases.filter(
    (alias) => !UUID.test(alias) && alias.toLowerCase() !== title.toLowerCase() && alias.trim().length > 0,
  );
  if (identity.status === "unconfirmed" && !aliases.length) return "Unidentified model.";
  if (!aliases.length) return null;
  return `Also known as ${aliases.join(", ")}`;
}

export function eventFacts(event: Event, summary?: string): string[] {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const title = String(record?.name ?? event.entity_id);
  const lines: string[] = [];

  if (event.stream === "web" && before && after && Array.isArray(before.strings) && Array.isArray(after.strings)) {
    const { added, removed, meaningfulAdded, meaningfulRemoved } = webStringChanges(before.strings, after.strings);
    lines.push(
      `Changes: +${meaningfulAdded.length}/−${meaningfulRemoved.length} meaningful; ${added.length + removed.length} total`,
    );
    const shownAdded = meaningfulAdded.slice(0, 3);
    const shownRemoved = meaningfulRemoved.slice(0, 2);
    lines.push(
      ...shownAdded.map((item) => `+ ${item.slice(0, 180)}`),
      ...shownRemoved.map((item) => `− ${item.slice(0, 180)}`),
    );
    const hidden = meaningfulAdded.length - shownAdded.length + (meaningfulRemoved.length - shownRemoved.length);
    if (hidden > 0) lines.push(`…and ${hidden} more material changes not shown`);
    if (!meaningfulAdded.length && !meaningfulRemoved.length) lines.push("No material user-facing text changed.");
    lines.push("A public text change is not yet confirmation that a feature shipped.");
  } else if (event.stream === "arena" && before && after && before.name !== after.name) {
    lines.push(`${describe(before.name)} → ${describe(after.name)}`);
    if (after.maker && after.maker !== before.maker) lines.push(`Identified as ${describe(after.maker)}`);
    for (const key of ["input", "output", "selectable"])
      if (canonical(before[key]) !== canonical(after[key])) lines.push(transition(key, before[key], after[key]));
  } else if (event.stream === "arena" && !before && after) {
    lines.push(
      after.selectable === false
        ? "Appeared on Arena, not yet selectable — usually a model being tested before announcement"
        : "Appeared on Arena and can be picked",
    );
    for (const key of ["model", "input", "output"])
      if (present(after[key]) && canonical(after[key]) !== canonical(after.name))
        lines.push(`${fieldLabels[key] ?? key}: ${value(key, after[key])}`);
  } else if (event.stream === "leaderboards" && !before && after) {
    lines.push(
      after.rank
        ? `Enters ${describe(after.category)} at rank ${describe(after.rank)}`
        : `Enters ${describe(after.category)}, outside the leading places`,
    );
    for (const key of ["score", "modelKey", "votes"])
      if (present(after[key])) lines.push(`${fieldLabels[key] ?? key}: ${value(key, after[key])}`);
  } else if (event.stream === "leaderboards" && before && after) {
    if (canonical(before.category) !== canonical(after.category))
      lines.push(`Benchmark: ${describe(before.category)} → ${describe(after.category)}`);
    else if (present(after.category) || present(before.category))
      lines.push(`Benchmark: ${describe(after.category ?? before.category)}`);
    if (canonical(before.rank) !== canonical(after.rank)) {
      if (present(before.rank) && present(after.rank)) lines.push(rankMove(before.rank, after.rank));
      else if (present(before.rank)) lines.push(`Falls outside tracked top 20 (was rank ${describe(before.rank)})`);
      else if (present(after.rank)) lines.push(`Enters tracked top 20 at rank ${describe(after.rank)}`);
    }
    for (const key of ["score", "modelKey", "votes"])
      if (canonical(before[key]) !== canonical(after[key])) lines.push(transition(key, before[key], after[key]));
  } else if (event.stream === "leaderboards" && before && !after) {
    lines.push(`Leaves ${describe(before.category)}`);
    if (present(before.rank)) lines.push(`Last observed rank: ${describe(before.rank)}`);
  } else if (event.stream === "github") {
    if (record?.stage) lines.push(describe(record.stage));
    else if (event.source.endsWith(":commits")) lines.push("Repository change; not a release yet");
    else if (event.source.endsWith(":releases")) lines.push("Published release");
    if (record?.author) lines.push(`Author: ${describe(record.author)} (${describe(record.association)})`);
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
      if (key === "name") {
        // A package name carries its version, so "openai 3.12.0 → openai 3.13.0" and
        // "3.12.0 → 3.13.0" are the same sentence twice.
        if (canonical(before.version) === canonical(after.version))
          lines.push(`${describe(before[key])} → ${describe(after[key])}`);
        continue;
      }
      if (key === "version") {
        lines.push(`${describe(before[key])} → ${describe(after[key])}`);
        continue;
      }
      if (Array.isArray(before[key]) && Array.isArray(after[key])) {
        const old = before[key] as unknown[];
        const next = after[key] as unknown[];
        const added = next.filter((item) => !old.some((previous) => canonical(previous) === canonical(item)));
        const removed = old.filter((item) => !next.some((current) => canonical(current) === canonical(item)));
        if (added.length) lines.push(`${fieldLabels[key] ?? key}: + ${describe(added)}`);
        if (removed.length) lines.push(`${fieldLabels[key] ?? key}: − ${describe(removed)}`);
        continue;
      }
      lines.push(transition(key, before[key], after[key]));
    }
  } else {
    for (const [key, raw] of Object.entries(record ?? {})) {
      if (key === "id" || key === "name" || key === "prerelease" || NOISE.has(key)) continue;
      // The full list of supported API parameters is retained evidence that no reader decides
      // anything from. When it changes, the added and removed entries are shown instead.
      if (key === "parameters") continue;
      // Whether a listing can be used is stated as a sentence, not as "Selectable: yes". A maker
      // that repeats the provider is one line spent on nothing.
      if (key === "selectable") continue;
      if (key === "maker" && canonical(raw) === canonical(record?.provider)) continue;
      if (key === "pricing") lines.push(...prices(null, raw, event.source));
      else if (["description", "summary", "message"].includes(key)) lines.push(describe(raw));
      // A field a source left empty is absence of evidence, not a fact about the model.
      else if (present(raw)) lines.push(`${fieldLabels[key] ?? key}: ${value(key, raw)}`);
    }
  }

  const collapsed = collapseDetails(lines);
  const identity =
    event.stream === "arena" || event.stream === "leaderboards" ? identityLine(event, record, title) : null;
  return [...(summary ? [`AI summary: ${summary}`] : []), ...collapsed, ...(identity ? [identity] : [])];
}
