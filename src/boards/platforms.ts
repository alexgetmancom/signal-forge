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
/** A component's own state, in the words Statuspage uses for it. Anything else is not a healthy one. */
const COMPONENTS: Record<string, string> = {
  operational: "🟢",
  degraded_performance: "🟡",
  partial_outage: "🟠",
  major_outage: "🔴",
  under_maintenance: "🔵",
};

/**
 * How many missed polls make a stored observation stop speaking for the present. Three, because one
 * missed poll is a timeout and two is a bad minute, while a vendor's page being unreadable for
 * three intervals running is itself the news — and until it is read again, what it last said is
 * history rather than status.
 */
const STALE_INTERVALS = 3;

function ago(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** What each platform's own status page says right now, read from the stored observation. */
export function platformEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const lines: string[] = [];
  let worst = "none";
  // An unread, stale or unreadable platform is not a healthy one, and the board's colour says so:
  // it ranks with `minor`, which is the point at which the board stops being green.
  const escalate = (indicator: string) => {
    if ((INDICATOR_RANK[indicator] ?? INDICATOR_RANK.minor ?? 0) > (INDICATOR_RANK[worst] ?? 0)) worst = indicator;
  };
  const lastSuccess = db.query<{ last_success: string | null }, [string]>(
    "SELECT last_success FROM sources WHERE id=?",
  );
  for (const platform of PLATFORMS) {
    const payload = readLatestSnapshot(db, `status:${platform.id}`);
    if (!payload) {
      lines.push(`⚪ **${platform.name}** — not read yet`);
      escalate("unknown");
      continue;
    }
    // The snapshot's own age cannot answer this: two identical successful polls reuse one snapshot,
    // so a stored observation is as old as the last time the page was read, which only the source
    // row knows. Without it, a green snapshot from five failed polls ago still read green under
    // today's timestamp.
    const success = lastSuccess.get(`status:${platform.id}`)?.last_success;
    const since = success ? now - Date.parse(success) : null;
    if (since === null || Number.isNaN(since) || since > platform.interval * STALE_INTERVALS * 1000) {
      lines.push(
        `⚪ **${platform.name}** — unknown, page not read since ${success && since !== null && !Number.isNaN(since) ? ago(since) : "ever"}`,
      );
      escalate("unknown");
      continue;
    }
    const raw = JSON.parse(payload) as {
      headline?: string;
      indicator?: string;
      components?: { name: string; status: string; group: string | null }[];
      incidents?: { name: string; status: string; impact: string }[];
    };
    const indicator = raw.indicator ?? "unknown";
    escalate(indicator);
    lines.push(`${INDICATORS[indicator] ?? "⚪"} **${platform.name}** — ${raw.headline ?? "unknown"}`);
    // The components a reader is on a plan for, named, because a vendor-wide headline does not say
    // which of them it is about. Only the watched ones: hundreds of hosted models in one embed is
    // a board nobody reads.
    for (const component of raw.components ?? [])
      lines.push(
        `　${COMPONENTS[component.status] ?? "⚪"} ${component.group ? `${component.group} / ` : ""}${component.name}${
          COMPONENTS[component.status] ? "" : ` — ${component.status}`
        }`,
      );
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
