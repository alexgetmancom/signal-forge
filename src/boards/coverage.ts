/**
 * The coverage board: what the field discussed that no source of ours recorded. The report behind
 * it was meant to be run weekly by hand, and a report that has to be remembered stops being read.
 */

import type { Database } from "bun:sqlite";
import { coverageGaps } from "../reports/coverageGaps.js";
import { clip } from "../text.js";
import { COLORS } from "./embed.js";

/**
 * What the field discussed this week that no source of ours recorded. The report behind it was
 * written to be run weekly by hand, and a report that has to be remembered is a report that stops
 * being read; as a board it stays current by itself and changes only when a new gap appears.
 */
export function coverageEmbed(db: Database, now = Date.now()): Record<string, unknown> {
  const report = coverageGaps(db, 7, now);
  const gaps = report.gaps.slice(-10).reverse();
  const lines = gaps.length
    ? [
        `**${report.gaps.length}** of **${report.stories - report.unjudged}** stories seen only on Hacker News`,
        "",
        ...gaps.map((gap) => `· [${clip(gap.title, 90)}](${gap.discussion ?? gap.url})`),
      ]
    : [`Every one of **${report.stories - report.unjudged}** stories was also recorded by another source`];
  return {
    title: "Missed by our sources, last 7 days",
    description: lines.join("\n"),
    color: gaps.length ? COLORS.degraded : COLORS.ok,
    footer: { text: "Run `coverage-gaps` for links and dates · questions and rants are not judged" },
    timestamp: new Date(now).toISOString(),
  };
}
