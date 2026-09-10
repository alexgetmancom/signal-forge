import { sourceLabel } from "../../sources/labels.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import type { Event, RecordData } from "../types.js";
import { utcStamp } from "./common.js";
import { renderEvent } from "./telegram.js";

export type StoryRenderEvent = Event & { url: string };

const KIND_LABELS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };
const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

function recordFor(event: Event): RecordData | null {
  const raw = event.after_json ?? event.before_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecordData;
  } catch {
    return null;
  }
}

function recordUrl(event: StoryRenderEvent, record: RecordData | null): string {
  return typeof record?.url === "string" ? record.url : event.url;
}

function detailLines(event: StoryRenderEvent, summary?: string): string[] {
  const lines = renderEvent(event, event.url, "telegram", summary).split("\n");
  return lines.slice(3, -3);
}

function storyTitle(events: StoryRenderEvent[]): string {
  const latest = events.at(-1) ?? events[0];
  if (!latest) return "Related updates";
  const record = recordFor(latest);
  return String(record?.name ?? latest.entity_id);
}

function latestEvent(events: StoryRenderEvent[]): StoryRenderEvent {
  return events.reduce(
    (latest, event) => (event.detected_at > latest.detected_at ? event : latest),
    events[0] as StoryRenderEvent,
  );
}

function linkEvidence(line: string, source: string): string {
  if (!line.startsWith("Evidence: ")) return line;
  const link = line.slice("Evidence: ".length).trim();
  return `[Open ${sourceLabel(source)} evidence](${link})`;
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
  const types = [
    ...new Set(
      events.map((event) => evidenceLabel(event.evidence_type ?? evidenceTypeFor(event.source, event.stream))),
    ),
  ];
  const confidences = [...new Set(events.map((event) => event.confidence ?? "observed"))];
  const stamp = Math.floor(Date.parse(latest.detected_at) / 1000);
  const time = platform === "discord" ? `<t:${stamp}:f>` : utcStamp(latest.detected_at);
  lines.push(`Signal Forge · ${types.join(", ")} · ${confidences.join(", ")} · ${time}`);
  return lines.join("\n");
}

/** Discord representation of a story: one embed with links to every independent evidence event. */
export function storyEmbed(
  events: StoryRenderEvent[],
  summaries: Map<number, string> = new Map(),
): Record<string, unknown> {
  if (!events.length) throw new Error("Cannot render an empty story");
  const first = events[0] as StoryRenderEvent;
  const latest = latestEvent(events);
  const firstRecord = recordFor(first);
  const sources = [...new Set(events.map((event) => sourceLabel(event.source)))];
  const body = renderStoryText(events, "discord", summaries).split("\n");
  let evidenceIndex = 0;
  const description = body
    .slice(2, -1)
    .map((line) => {
      if (!line.startsWith("Evidence: ")) return line;
      const source = events[evidenceIndex]?.source ?? first.source;
      evidenceIndex++;
      return linkEvidence(line, source);
    })
    .join("\n")
    .trim()
    .slice(0, 4000);
  const kinds = events.map((event) => event.kind);
  const kind = kinds.includes("changed") ? "changed" : kinds.includes("new") ? "new" : "removed";
  const vendor = vendorOf(latest, recordFor(latest));
  const types = [
    ...new Set(
      events.map((event) => evidenceLabel(event.evidence_type ?? evidenceTypeFor(event.source, event.stream))),
    ),
  ];
  const confidences = [...new Set(events.map((event) => event.confidence ?? "observed"))];
  const latestStamp = Math.floor(Date.parse(latest.detected_at) / 1000);
  const embed: Record<string, unknown> = {
    author: { name: ["STORY", vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · ") },
    title: `🧵 Story · ${storyTitle(events)}`.slice(0, 250),
    color: KIND_COLORS[kind],
    description,
    fields: [
      { name: "Sources", value: `${events.length} updates · ${sources.join(" → ")}`, inline: false },
      { name: "Confidence", value: confidences.join(", "), inline: true },
      { name: "Latest", value: `<t:${latestStamp}:R>\n<t:${latestStamp}:f>`, inline: true },
    ],
    footer: { text: `Evidence: ${types.join(", ")} · Confidence: ${confidences.join(", ")}` },
  };
  const link = recordUrl(first, firstRecord);
  if (link) embed.url = link;
  return embed;
}
