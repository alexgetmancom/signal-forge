import { sourceLabel } from "../../sources/labels.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import type { Event, RecordData } from "../types.js";
import { DESCRIPTION_CHARACTERS } from "./budget.js";
import { eventFacts } from "./facts.js";

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
};

const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

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
export function eventHeadline(event: Event, record: RecordData | null): string {
  const name = String(record?.name ?? event.entity_id);
  if (event.stream === "deprecations" && event.kind === "new") return `⚠️ Action required · ${name}`;
  return `${KIND_ICONS[event.kind]} ${name}`;
}

/** What the observation means for someone deciding whether to care. */
function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "deprecations")
    return "Check the notice for the deadline and replacement before changing integrations.";
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  if (event.stream === "openrouter" && record?.selectable === true) return "Available to use from this catalogue.";
  if (event.stream === "openrouter" && record?.selectable === false)
    return "Listed in this catalogue, but not selectable yet.";
  // A first Arena sighting already says this in its own words; repeating it costs a line.
  if (event.stream === "arena" && event.kind !== "new")
    return record?.selectable === false
      ? "Visible on Arena, but not selectable yet."
      : "Visible and selectable on Arena.";
  if (event.kind === "removed") return "No longer present in this source's latest observation.";
  if (event.stream === "packages" && event.kind === "new") return "A package release was published to the registry.";
  return null;
}

export function eventEmbed(event: Event, url: string, summary?: string): Record<string, unknown> {
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
  const facts = eventFacts(event).filter((line) => line.toLowerCase() !== `maker: ${vendor.toLowerCase()}`);
  const impact = readerImpact(event, record);
  // One voice per line: the model's own summary, then what it means, then the evidence itself.
  const description = [...(summary ? [`*${summary}*`] : []), ...(impact ? [impact] : []), ...facts]
    .join("\n")
    .slice(0, DESCRIPTION_CHARACTERS);
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);

  const embed: Record<string, unknown> = {
    author: {
      name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
    },
    title: eventHeadline(event, record).slice(0, 250),
    color: KIND_COLORS[event.kind],
    description,
    // Discord renders its own timestamp in the reader's timezone, which is one line of card spent
    // on something the client already does.
    timestamp: new Date(event.detected_at).toISOString(),
    footer: {
      text: `${sourceLabel(event.source)} · ${evidenceLabel(evidenceType)} · ${event.confidence ?? "observed"}`,
    },
  };
  if (link) embed.url = link;
  return embed;
}
