import { sourceLabel } from "../../sources/labels.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import type { Event, RecordData } from "../types.js";
import { renderEvent } from "./telegram.js";

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
};

const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

const KIND_ICONS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };

function kindWord(kind: Event["kind"]): string {
  return { new: "New", changed: "Changed", removed: "Removed" }[kind];
}

function eyebrow(event: Event): string {
  if (event.source === "codex-docs") return "DOCUMENTATION";
  if (event.stream === "leaderboards") return sourceLabel(event.source).toUpperCase();
  return EYEBROWS[event.stream] ?? "UPDATE";
}

/** A scan-first headline that states the kind of change before the entity name. */
export function eventHeadline(event: Event, record: RecordData | null): string {
  if (event.stream === "deprecations") {
    if (event.kind === "new") return "⚠️ Action required · Deprecation notice";
    return `${KIND_ICONS[event.kind]} Deprecation notice ${event.kind === "changed" ? "updated" : "removed"}`;
  }
  if (event.stream === "github") {
    if (event.source.endsWith(":releases"))
      return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "Release published" : event.kind === "changed" ? "Release updated" : "Release removed"}`;
    return `${KIND_ICONS[event.kind]} Repository change ${event.kind === "new" ? "detected" : event.kind === "changed" ? "updated" : "removed"}`;
  }
  if (event.stream === "packages")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "Package release published" : event.kind === "changed" ? "Package release updated" : "Package release removed"}`;
  if (event.stream === "leaderboards") {
    return `${KIND_ICONS[event.kind]} Leaderboard ${event.kind === "changed" ? "movement" : event.kind === "new" ? "entry added" : "entry removed"}`;
  }
  if (event.stream === "arena")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "New Arena appearance" : event.kind === "changed" ? "Arena appearance updated" : "Arena appearance removed"}`;
  if (event.stream === "web") {
    const noun = event.source === "codex-docs" ? "Documentation" : "Web page";
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "New" : event.kind === "changed" ? "Changed" : "Removed"} ${noun} signal`;
  }
  if (event.stream === "news")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "Official announcement" : event.kind === "changed" ? "Official announcement updated" : "Official announcement removed"}`;
  if (event.stream === "incidents")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "Platform incident" : event.kind === "changed" ? "Platform incident updated" : "Platform incident removed"}`;
  if (event.stream === "weights")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "New open-weight release" : event.kind === "changed" ? "Open-weight record updated" : "Open-weight release removed"}`;
  if (event.stream === "api-models")
    return `${KIND_ICONS[event.kind]} ${event.kind === "new" ? "New API model" : event.kind === "changed" ? "API model updated" : "API model removed"}`;
  if (event.stream === "openrouter") {
    const available = record?.selectable === true ? "available" : "listing";
    if (event.kind === "new") return `${KIND_ICONS[event.kind]} New model ${available}`;
    if (event.kind === "changed") return `${KIND_ICONS[event.kind]} Model availability updated`;
    return `${KIND_ICONS[event.kind]} Model listing removed`;
  }
  return `${KIND_ICONS[event.kind]} ${kindWord(event.kind)} update`;
}

function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "deprecations")
    return "Check the notice for the deadline and replacement before changing integrations.";
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  if (event.stream === "web" && event.kind === "changed")
    return "A public text change; this is not confirmation that a feature shipped.";
  if (event.stream === "openrouter" && record?.selectable === true) return "Available to use from this catalogue.";
  if (event.stream === "openrouter" && record?.selectable === false)
    return "Listed in this catalogue, but not selectable yet.";
  if (event.stream === "arena" && record?.selectable === false) return "Visible on Arena, but not selectable yet.";
  if (event.stream === "arena" && record?.selectable === true) return "Visible and selectable on Arena.";
  if (event.kind === "removed") return "No longer present in this source's latest observation.";
  if (event.stream === "packages" && event.kind === "new") return "A package release was published to the registry.";
  return null;
}

export function eventEmbed(event: Event, url: string, summary?: string): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const link =
    event.stream === "leaderboards"
      ? url
      : typeof record?.url === "string"
        ? record.url
        : event.source === "openrouter"
          ? `https://openrouter.ai/${event.entity_id}`
          : url;
  const rendered = renderEvent(event, url).split("\n");
  const body = rendered.slice(2, -2).join("\n").trim();
  const vendor = vendorOf(event, record);
  const evidence = body
    .split("\n")
    .filter((line) => line.toLowerCase() !== `maker: ${vendor.toLowerCase()}`)
    .join("\n");
  const impact = readerImpact(event, record);
  const stamp = Math.floor(Date.parse(event.detected_at) / 1000);
  const description = [
    event.stream === "leaderboards" && link ? `**Source**\n${link}` : null,
    summary ? `**Summary**\n${summary}` : null,
    evidence ? `**What changed**\n${evidence}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .slice(0, 4000);

  const embed: Record<string, unknown> = {
    author: {
      name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
    },
    title: `${eventHeadline(event, record)} · ${String(record?.name ?? event.entity_id)}`.slice(0, 250),
    color: KIND_COLORS[event.kind],
    description,
    fields: [
      {
        name: "Signal",
        value: `${(event.confidence ?? "observed").replace(/^./, (letter) => letter.toUpperCase())} · ${evidenceLabel(event.evidence_type ?? evidenceTypeFor(event.source, event.stream))}`,
        inline: true,
      },
      { name: "Detected", value: `<t:${stamp}:R>\n<t:${stamp}:f>`, inline: true },
      ...(impact ? [{ name: "Reader impact", value: impact, inline: false }] : []),
    ],
  };
  if (link) embed.url = link;
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  embed.footer = { text: `Evidence: ${evidenceLabel(evidenceType)} · Confidence: ${event.confidence ?? "observed"}` };
  return embed;
}
