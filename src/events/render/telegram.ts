import type { Destination } from "../../config.js";
import { sourceLabel } from "../../sources/labels.js";
import { canonical } from "../canonical.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
import { identityFor } from "../identity.js";
import type { Event, RecordData } from "../types.js";
import {
  collapseDetails,
  describe,
  fieldLabels,
  meaningfulWebString,
  NOISE,
  prices,
  rankMove,
  utcStamp,
} from "./common.js";

export function renderEvent(
  event: Event,
  url: string,
  reportBaseUrl?: string,
  platform: Destination["platform"] = "telegram",
): string {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const labels = { new: "🆕 New", changed: "✏️ Changed", removed: "🗑️ Removed" };
  const lines = [`${labels[event.kind]} · ${sourceLabel(event.source)}`, String(record?.name ?? event.entity_id), ""];
  if (event.stream === "web" && before && after && Array.isArray(before.strings) && Array.isArray(after.strings)) {
    const previous = new Set(before.strings as string[]),
      current = new Set(after.strings as string[]);
    const added = [...current].filter((value) => !previous.has(value)),
      removed = [...previous].filter((value) => !current.has(value));
    const usefulAdded = added.filter(meaningfulWebString);
    const usefulRemoved = removed.filter(meaningfulWebString);
    lines.push(
      `Meaningful strings: +${usefulAdded.length}/−${usefulRemoved.length}; total changed: +${added.length}/−${removed.length}`,
    );
    lines.push(
      ...usefulAdded.slice(0, 12).map((value) => `+ ${value.slice(0, 180)}`),
      ...usefulRemoved.slice(0, 3).map((value) => `− ${value.slice(0, 180)}`),
    );
    if (!usefulAdded.length && !usefulRemoved.length)
      lines.push("Only boilerplate or short strings; the report has the details.");
    lines.push("A public text change is not yet confirmation that a feature shipped.");
  } else if (event.stream === "arena" && before && after && before.name !== after.name) {
    lines.push(`${describe(before.name)} → ${describe(after.name)}`);
    if (after.maker && after.maker !== before.maker) lines.push(`Identified as ${describe(after.maker)}`);
    for (const key of ["input", "output", "selectable"])
      if (canonical(before[key]) !== canonical(after[key]))
        lines.push(`${fieldLabels[key] ?? key}: ${describe(before[key])} → ${describe(after[key])}`);
  } else if (event.stream === "arena" && !before && after) {
    lines.push(
      after.selectable === false
        ? "Appeared on Arena, not yet selectable — usually a model being tested before announcement"
        : "Appeared on Arena and can be picked",
    );
    for (const key of ["model", "input", "output"])
      if (after[key] !== undefined && canonical(after[key]) !== canonical(after.name))
        lines.push(`${fieldLabels[key] ?? key}: ${describe(after[key])}`);
  } else if (event.stream === "leaderboards" && !before && after) {
    lines.push(
      after.rank
        ? `Enters ${describe(after.category)} at rank ${describe(after.rank)}`
        : `Enters ${describe(after.category)}, outside the leading places`,
    );
    for (const [key, label] of [
      ["score", "Score"],
      ["modelKey", "Variant"],
      ["votes", "Votes"],
      ["sampledAt", "Sampled"],
    ] as const)
      if (after[key] !== undefined) lines.push(`${label}: ${describe(after[key])}`);
  } else if (event.stream === "leaderboards" && before && after) {
    if (canonical(before.category) !== canonical(after.category))
      lines.push(`Benchmark: ${describe(before.category)} → ${describe(after.category)}`);
    if (canonical(before.rank) !== canonical(after.rank)) {
      if (before.rank !== undefined && after.rank !== undefined) lines.push(rankMove(before.rank, after.rank));
      else lines.push(`Rank: ${describe(before.rank)} → ${describe(after.rank)}`);
    }
    for (const [key, label] of [
      ["score", "Score"],
      ["modelKey", "Variant"],
      ["votes", "Votes"],
      ["sampledAt", "Sampled"],
    ] as const)
      if (canonical(before[key]) !== canonical(after[key]))
        lines.push(`${label}: ${describe(before[key])} → ${describe(after[key])}`);
  } else if (event.stream === "github") {
    if (record?.stage) lines.push(describe(record.stage));
    else if (event.source.endsWith(":commits")) lines.push("Repository change; not a release yet");
    else if (event.source.endsWith(":releases")) lines.push("Published release");
    if (record?.author) lines.push(`Author: ${describe(record.author)} (${describe(record.association)})`);
    lines.push(describe(record?.summary));
  } else if (before && after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (NOISE.has(key) || canonical(before[key]) === canonical(after[key])) continue;
      if (key === "pricing") {
        lines.push(...prices(before[key], after[key]));
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
      if (key === "version") {
        lines.push(`${describe(before[key])} → ${describe(after[key])}`);
        continue;
      }
      if (Array.isArray(before[key]) && Array.isArray(after[key])) {
        const old = before[key] as unknown[],
          next = after[key] as unknown[];
        const added = next.filter((value) => !old.some((oldValue) => canonical(oldValue) === canonical(value))),
          removed = old.filter((value) => !next.some((nextValue) => canonical(nextValue) === canonical(value)));
        if (added.length) lines.push(`${fieldLabels[key] ?? key}: + ${describe(added)}`);
        if (removed.length) lines.push(`${fieldLabels[key] ?? key}: − ${describe(removed)}`);
      } else lines.push(`${fieldLabels[key] ?? key}: ${describe(before[key])} → ${describe(after[key])}`);
    }
  } else {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (key === "id" || key === "name" || key === "prerelease" || NOISE.has(key)) continue;
      if (key === "pricing") lines.push(...prices(null, value));
      else if (["description", "summary", "message"].includes(key)) lines.push(describe(value));
      else lines.push(`${fieldLabels[key] ?? key}: ${describe(value)}`);
    }
  }
  if (event.stream === "arena" || event.stream === "leaderboards") {
    const identity = identityFor(event, record);
    if (identity.status !== "canonical") {
      lines.push(
        `Identity: ${identity.status}${identity.aliases.length ? ` · aliases: ${identity.aliases.join(", ")}` : ""}`,
      );
    }
  }
  lines.push(...collapseDetails(lines.splice(3)));
  const link =
    typeof record?.url === "string"
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  const stamp = Math.floor(Date.parse(event.detected_at) / 1000);
  const time = platform === "discord" ? `<t:${stamp}:f>` : utcStamp(event.detected_at);
  lines.push("", link);
  if (reportBaseUrl && event.stream === "web")
    lines.push(`Full report: ${reportBaseUrl.replace(/\/$/, "")}/reports/${event.id}`);
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  lines.push(`Signal Forge · ${evidenceLabel(evidenceType)} · ${event.confidence ?? "observed"} · ${time}`);
  return lines.join("\n");
}
