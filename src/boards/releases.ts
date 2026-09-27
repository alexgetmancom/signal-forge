/**
 * The release board: this week's releases, each with the source that named it first, how far behind
 * the model's own timestamp that was, and whether it ever made a card.
 */

import type { Database } from "bun:sqlite";
import { INDEPENDENT_SOURCES } from "../events/corroboration.js";
import { releaseAudit } from "../reports/releaseAudit.js";
import { clip } from "../text.js";
import { COLORS } from "./embed.js";

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/**
 * This week's releases, each with the source that named it first, how long after the model's own
 * timestamp, and whether it made a card: the audit that was run by hand after MiMo V2.6.
 */
export function releaseAuditEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const { releases } = releaseAudit(db, 7, now);
  // The board turns red for a miss nothing explains, not for a name the threshold held back.
  const missed = releases.filter((release) => release.silence === "unexplained").length;
  const lines = releases.length
    ? releases
        .slice(-20)
        .reverse()
        .map((release) => {
          const lag =
            release.lagMinutes === null ? "" : ` · ${minutesText(release.lagMinutes)} after its own timestamp`;
          const card = release.cardAt
            ? `card ${minutesText(Math.max(0, Math.round((Date.parse(release.cardAt) - Date.parse(release.firstSeenAt)) / 60_000)))} later`
            : release.silence === "below_the_agreement_threshold"
              ? `quiet · ${release.families} of ${INDEPENDENT_SOURCES} sources agreed`
              : "**no card**";
          return `· **${clip(release.model, 60)}** — ${release.firstLabel} ${release.firstSeenAt.slice(5, 16).replace("T", " ")}${lag} · ${card}`;
        })
    : ["No model was released this week"];
  return {
    title: "Releases, last 7 days",
    description: lines.join("\n"),
    color: missed ? COLORS.degraded : COLORS.ok,
    footer: { text: "First source · lag behind the model's own created time · card delay · times UTC" },
    timestamp: new Date(now).toISOString(),
  };
}
