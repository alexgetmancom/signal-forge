/**
 * The platform board: what each vendor's own status page says right now, read from the stored
 * observation rather than fetched while the board is being drawn.
 */

import type { Database } from "bun:sqlite";
import { PLATFORMS } from "../sources/platforms.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { clip } from "../text.js";
import { COLORS } from "./embed.js";

const INDICATORS: Record<string, string> = {
  none: "🟢",
  minor: "🟡",
  major: "🟠",
  critical: "🔴",
  maintenance: "🔵",
};
const INDICATOR_RANK: Record<string, number> = { none: 0, maintenance: 1, minor: 2, major: 3, critical: 4 };

/** What each platform's own status page says right now, read from the stored observation. */
export function platformEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const lines: string[] = [];
  let worst = "none";
  for (const platform of PLATFORMS) {
    const payload = readLatestSnapshot(db, `status:${platform.id}`);
    if (!payload) {
      lines.push(`⚪ **${platform.name}** — not read yet`);
      continue;
    }
    const raw = JSON.parse(payload) as {
      headline?: string;
      indicator?: string;
      incidents?: { name: string; status: string; impact: string }[];
    };
    const indicator = raw.indicator ?? "none";
    // An indicator this board does not know is not a healthy one: it reads as degraded until named.
    if ((INDICATOR_RANK[indicator] ?? INDICATOR_RANK.minor ?? 0) > (INDICATOR_RANK[worst] ?? 0)) worst = indicator;
    lines.push(`${INDICATORS[indicator] ?? "⚪"} **${platform.name}** — ${raw.headline ?? "unknown"}`);
    for (const incident of (raw.incidents ?? []).slice(0, 3))
      lines.push(`　└ ${incident.name} (${incident.status}, ${incident.impact})`);
  }
  return {
    title: "Platform health",
    description: clip(lines.join("\n"), 4000),
    color: worst === "none" ? COLORS.ok : worst === "critical" || worst === "major" ? COLORS.down : COLORS.degraded,
    footer: { text: "Read from each vendor's own status page · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}
