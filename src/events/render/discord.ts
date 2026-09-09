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

export function eventEmbed(
  event: Event,
  url: string,
  reportBaseUrl?: string,
  summary?: string,
): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const rendered = renderEvent(event, url, undefined, "telegram").split("\n");
  const body = rendered.slice(2, -2).join("\n").trim();
  const vendor = vendorOf(event, record);
  const evidence = body
    .split("\n")
    .filter((line) => line.toLowerCase() !== `maker: ${vendor.toLowerCase()}`)
    .join("\n");
  const description = (summary ? `AI summary: ${summary}\n\n${evidence}` : evidence).slice(0, 4000);
  const link =
    typeof record?.url === "string"
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;

  const embed: Record<string, unknown> = {
    author: {
      name: [EYEBROWS[event.stream] ?? "UPDATE", vendor === "Unknown" ? null : vendor.toUpperCase()]
        .filter(Boolean)
        .join(" · "),
    },
    title: String(record?.name ?? event.entity_id).slice(0, 250),
    color: KIND_COLORS[event.kind],
    description,
  };
  if (link) embed.url = link;
  if (reportBaseUrl && event.stream === "web")
    embed.fields = [
      { name: "Full report", value: `${reportBaseUrl.replace(/\/$/, "")}/reports/${event.id}`, inline: false },
    ];
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  embed.footer = { text: `Evidence: ${evidenceLabel(evidenceType)} · Confidence: ${event.confidence ?? "observed"}` };
  return embed;
}
