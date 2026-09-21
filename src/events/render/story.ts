import { sourceLabel } from "../../sources/labels.js";
import { clip } from "../../text.js";
import { eventEvidenceType, evidenceLabel } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import { recordFor } from "../record.js";
import type { Event, RecordData } from "../types.js";
import { utcStamp, withoutMakerPrefix } from "./common.js";
import { TRUST } from "./discord.js";
import { type CardContext, eventFactParts, eventFacts } from "./facts.js";
import { vendorColor, vendorLogo } from "./logos.js";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Discord representation of a story: what the events add up to, not one block per event.
 *
 * The story of qwen3.8-max on 2026-09-17 was five blocks of Accepts, Maker, Model, Returns, Provider
 * and Also known as for three arena rows and two leaderboard moves. What a reader needed was that
 * Qwen had tested it on the arena under three names, and where it now ranks.
 */
export function storyEmbed(
  events: StoryRenderEvent[],
  summaries: Map<number, string> = new Map(),
  detail: "brief" | "evidence" = "evidence",
): Record<string, unknown> {
  if (!events.length) throw new Error("Cannot render an empty story");
  const first = events[0] as StoryRenderEvent;
  const latest = latestEvent(events);
  const title = withoutMakerPrefix(storyTitle(events));
  const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Names the arena and leaderboards carried that are not the story's own.
  const aliases = [
    ...new Set(
      events
        .filter((event) => event.stream === "arena" || event.stream === "leaderboards")
        .flatMap((event) => {
          const record = recordFor(event);
          return [record?.name, record?.model, record?.modelKey];
        })
        .filter((name): name is string => typeof name === "string" && !UUID.test(name) && key(name) !== key(title)),
    ),
  ];
  // Where it ranks now: the latest reading per board.
  const boards = new Map<string, string>();
  for (const event of [...events].sort((one, other) => one.detected_at.localeCompare(other.detected_at))) {
    const record = event.stream === "leaderboards" ? (recordFor(event) as RecordData | null) : null;
    if (record && event.kind !== "removed" && record.rank !== undefined && record.rank !== null)
      boards.set(
        String(record.category ?? sourceLabel(event.source)),
        `#${String(record.rank)} ${String(record.category ?? "")}`.trim(),
      );
  }
  // Anything else that happened: one line each, in the words the event's own card would lead with.
  const others = events
    .filter((event) => event.stream !== "arena" && event.stream !== "leaderboards")
    .slice(-3)
    .map((event) => {
      const fact = eventFactParts(event, summaries.get(event.id))[0];
      const text = fact === undefined ? null : typeof fact === "string" ? fact : `${fact.label} ${fact.value}`;
      return `${KIND_LABELS[event.kind]} **${sourceLabel(event.source)}**${text ? ` · ${text}` : ""}`;
    });
  // Names only: the url an event carries is often the maker's page for the model, and "Arena ·
  // leaderboards" linking to qwencloud.com read as a broken link. The title links the story.
  const sources = new Set(events.map((event) => sourceLabel(event.source)));
  const sentence = aliases.length
    ? `Seen on Arena under ${aliases.length} other name${aliases.length === 1 ? "" : "s"}.`
    : `${events.length} updates from ${sources.size} source${sources.size === 1 ? "" : "s"}.`;
  const kinds = events.map((event) => event.kind);
  const kind = kinds.includes("changed") ? "changed" : kinds.includes("new") ? "new" : "removed";
  const vendor = vendorOf(latest, recordFor(latest));
  const confidences = [...new Set(events.map((event) => event.confidence ?? "observed"))];
  const fields = [
    ...(detail === "evidence" && aliases.length
      ? [
          {
            name: "Other names",
            value: aliases
              .slice(0, 6)
              .map((alias) => `\`${alias}\``)
              .join(", ")
              .slice(0, 1024),
            inline: false,
          },
        ]
      : []),
    ...(boards.size
      ? [{ name: "Leaderboards", value: [...boards.values()].slice(0, 4).join("\n"), inline: false }]
      : []),
    { name: "Seen on", value: [...sources].join(" · ").slice(0, 1024), inline: false },
  ];
  const embed: Record<string, unknown> = {
    author: { name: ["STORY", vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · ") },
    title: `🧵 ${title}`.slice(0, 250),
    // The maker's colour, as on its launch card, so a thread reads as the same model's.
    color: vendorColor(vendor) ?? KIND_COLORS[kind],
    description: clip([sentence, ...others].join("\n"), 4000),
    fields,
    // Discord shows its own timestamp in the reader's timezone; "Latest" said it once more as a field.
    timestamp: new Date(latest.detected_at).toISOString(),
    footer: {
      text:
        detail === "evidence"
          ? `Story · ${confidences.map((confidence) => TRUST[confidence] ?? confidence).join(", ")}`
          : "Story",
    },
  };
  const thumbnail = vendorLogo(vendor);
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  const link = recordUrl(first, recordFor(first));
  if (link) embed.url = link;
  return embed;
}
