import { sourceLabel } from "../../sources/labels.js";
import { eventEvidenceType, evidenceLabel } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import { recordFor } from "../record.js";
import type { Event, RecordData } from "../types.js";
import { type Fact, utcStamp } from "./common.js";
import { type CardContext, eventFactParts, eventFacts } from "./facts.js";
import { vendorLogo } from "./logos.js";

export type StoryRenderEvent = Event & CardContext & { url: string };

const KIND_LABELS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };
const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

function recordUrl(event: StoryRenderEvent, record: RecordData | null): string {
  return typeof record?.url === "string" && record.url.trim() ? record.url : event.url;
}

function detailLines(event: StoryRenderEvent, summary?: string): string[] {
  return eventFacts(event, summary);
}

function storyTitle(events: StoryRenderEvent[]): string {
  const latest = events.at(-1) ?? events[0];
  if (!latest) return "Related updates";
  const record = recordFor(latest);
  return displayTitle(String(record?.name ?? latest.entity_id), latest.stream, latest.source);
}

function latestEvent(events: StoryRenderEvent[]): StoryRenderEvent {
  return events.reduce(
    (latest, event) => (event.detected_at > latest.detected_at ? event : latest),
    events[0] as StoryRenderEvent,
  );
}

/** One reader-facing message for a correlated story, retaining every event link as evidence. */
export function renderStoryText(
  events: StoryRenderEvent[],
  platform: "telegram" | "discord" = "telegram",
  summaries: Map<number, string> = new Map(),
): string {
  if (!events.length) throw new Error("Cannot render an empty story");
  const latest = latestEvent(events);
  const vendors = [
    ...new Set(events.map((event) => vendorOf(event, recordFor(event))).filter((vendor) => vendor !== "Unknown")),
  ];
  const lines = [`🧵 Story · ${storyTitle(events)}`, vendors.length ? `Vendor: ${vendors.join(", ")}` : "", ""];
  events.forEach((event) => {
    const record = recordFor(event);
    const link = recordUrl(event, record);
    lines.push(`${KIND_LABELS[event.kind]} ${sourceLabel(event.source)}`);
    lines.push(...detailLines(event, summaries.get(event.id)));
    lines.push(`Evidence: ${link}`, "");
  });
  const types = [...new Set(events.map((event) => evidenceLabel(eventEvidenceType(event))))];
  const confidences = [...new Set(events.map((event) => event.confidence ?? "observed"))];
  const stamp = Math.floor(Date.parse(latest.detected_at) / 1000);
  const time = platform === "discord" ? `<t:${stamp}:f>` : utcStamp(latest.detected_at);
  lines.push(`Signal Forge · ${types.join(", ")} · ${confidences.join(", ")} · ${time}`);
  return lines.join("\n");
}

/**
 * Discord representation of a story: one block per update, each with its evidence link, and the
 * story's shape — how many sources, how sure, how recent — as fields beside it.
 */
export function storyEmbed(
  events: StoryRenderEvent[],
  summaries: Map<number, string> = new Map(),
): Record<string, unknown> {
  if (!events.length) throw new Error("Cannot render an empty story");
  const first = events[0] as StoryRenderEvent;
  const latest = latestEvent(events);
  const firstRecord = recordFor(first);
  const description = events
    .map((event) => {
      const link = recordUrl(event, recordFor(event));
      const facts = eventFactParts(event, summaries.get(event.id));
      const sentences = facts.filter((fact): fact is string => typeof fact === "string");
      // Values ride on one line per update: a story is several cards' worth, and a column of labels
      // for each of them is the wall of text this layout exists to avoid.
      const values = facts
        .filter((fact): fact is Exclude<Fact, string> => typeof fact !== "string")
        .map((fact) => `**${fact.label}** ${fact.value}`);
      return [
        `${KIND_LABELS[event.kind]} **${sourceLabel(event.source)}** · [evidence](${link})`,
        ...sentences,
        ...(values.length ? [values.join(" · ")] : []),
      ].join("\n");
    })
    .join("\n\n")
    .slice(0, 4000);
  const kinds = events.map((event) => event.kind);
  const kind = kinds.includes("changed") ? "changed" : kinds.includes("new") ? "new" : "removed";
  const vendor = vendorOf(latest, recordFor(latest));
  const sources = new Set(events.map((event) => event.source));
  const types = [...new Set(events.map((event) => evidenceLabel(eventEvidenceType(event))))];
  const confidences = [...new Set(events.map((event) => event.confidence ?? "observed"))];
  const latestStamp = Math.floor(Date.parse(latest.detected_at) / 1000);
  const embed: Record<string, unknown> = {
    author: { name: ["STORY", vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · ") },
    title: `🧵 ${storyTitle(events)}`.slice(0, 250),
    color: KIND_COLORS[kind],
    description,
    fields: [
      {
        name: "Sources",
        value: `${sources.size} source${sources.size === 1 ? "" : "s"} · ${events.length} updates`,
        inline: true,
      },
      { name: "Confidence", value: confidences.join(", "), inline: true },
      { name: "Latest", value: `<t:${latestStamp}:R>`, inline: true },
    ],
    footer: { text: types.join(" · ") },
  };
  const thumbnail = vendorLogo(vendor);
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  const link = recordUrl(first, firstRecord);
  if (link) embed.url = link;
  return embed;
}
