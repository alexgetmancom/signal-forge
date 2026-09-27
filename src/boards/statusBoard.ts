/**
 * The status board: the reading in health.ts, drawn, grouped, and ordered so that a source needing
 * attention survives the trim in embed.ts -- adding the Hugging Face router once pushed a failing
 * Arena off the board.
 */
import { COLORS } from "./embed.js";
import type { SourceHealth, SourceState } from "./health.js";

const DOTS: Record<SourceState, string> = {
  ok: "🟢",
  stale: "🟡",
  failing: "🔴",
  degraded: "🟡",
  blocked: "🔵",
  idle: "⚪",
  missing: "🟣",
  disabled: "⚫",
};

function utcStamp(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function statusEmbed(health: SourceHealth[], now = Date.now()): Record<string, unknown> {
  const failing = health.filter(
    (entry) => entry.state === "failing" || entry.state === "stale" || entry.state === "degraded",
  );
  const blocked = health.filter((entry) => entry.state === "blocked");
  const unavailable = health.filter((entry) => entry.state === "missing" || entry.state === "disabled");
  const activeCount = health.length - unavailable.length;
  const headline =
    failing.length === 0
      ? `${DOTS.ok} ${activeCount} active collectors reporting`
      : `${DOTS.failing} ${failing.length} of ${activeCount} active collectors need attention`;

  const visibleHealth = health.filter((entry) => entry.state !== "missing" && entry.state !== "disabled");
  // fitEmbed drops the last sections once the board is full, so a group with a collector that needs
  // attention comes first: adding the Hugging Face router pushed a failing Arena off the board.
  const groups = [...new Set(visibleHealth.map((entry) => entry.group))].sort(
    (left, right) =>
      Number(visibleHealth.some((entry) => entry.group === right && entry.state !== "ok")) -
      Number(visibleHealth.some((entry) => entry.group === left && entry.state !== "ok")),
  );
  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const group of groups) {
    const rows = health
      .filter((entry) => entry.group === group && entry.state !== "missing" && entry.state !== "disabled")
      .map((entry) => {
        // A green collector is green because it was observed within its own schedule, so its
        // authority and its timestamp say nothing its dot did not. Spelling them out for every
        // healthy source is what pushed this embed past what Discord accepts; the sources that
        // need a reader's attention keep every word of it.
        if (entry.state === "ok") return `${DOTS.ok} ${entry.label}`;
        const last = entry.lastSuccess ? ` · ${utcStamp(entry.lastSuccess)}` : "";
        return `${DOTS[entry.state]} ${entry.label} · ${entry.authority.replace("_", "-")}${entry.detail ? ` — ${entry.detail}` : ""}${last}`;
      });
    let page = 1;
    let value = "";
    for (const row of rows) {
      const next = value ? `${value}\n${row}` : row;
      if (value && next.length > 1024) {
        fields.push({ name: page === 1 ? group : `${group} (${page})`, value, inline: false });
        page += 1;
        value = row;
      } else value = next;
    }
    if (value) fields.push({ name: page === 1 ? group : `${group} (${page})`, value, inline: false });
  }

  return {
    title: "Tracker status",
    description: `${headline}${blocked.length ? `\n${DOTS.blocked} ${blocked.length} waiting on upstream` : ""}${unavailable.length ? `\n${DOTS.missing} ${unavailable.length} sources outside current coverage` : ""}`,
    color:
      failing.length === 0 ? COLORS.ok : failing.some((e) => e.state === "failing") ? COLORS.down : COLORS.degraded,
    fields,
    footer: { text: "Signal Forge · green means observed on schedule · updates itself in place" },
    timestamp: new Date(now).toISOString(),
  };
}
