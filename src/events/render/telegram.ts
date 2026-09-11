import type { Destination } from "../../config.js";
import { sourceLabel } from "../../sources/labels.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
import type { Event, RecordData } from "../types.js";
import { utcStamp } from "./common.js";
import { eventFacts } from "./facts.js";

export function renderEvent(
  event: Event,
  url: string,
  platform: Destination["platform"] = "telegram",
  summary?: string,
): string {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const labels = { new: "🆕 New", changed: "✏️ Changed", removed: "🗑️ Removed" };
  const link =
    typeof record?.url === "string" && record.url.trim()
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  const stamp = Math.floor(Date.parse(event.detected_at) / 1000);
  const time = platform === "discord" ? `<t:${stamp}:f>` : utcStamp(event.detected_at);
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  return [
    `${labels[event.kind]} · ${sourceLabel(event.source)}`,
    String(record?.name ?? event.entity_id),
    "",
    ...eventFacts(event, summary),
    "",
    link,
    `Signal Forge · ${evidenceLabel(evidenceType)} · ${event.confidence ?? "observed"} · ${time}`,
  ].join("\n");
}
