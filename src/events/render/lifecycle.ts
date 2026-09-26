import { z } from "zod";
import type { RecapContext } from "../../recap.js";
import { sourceLabel } from "../../sources/labels.js";
import { clip } from "../../text.js";
import type { Event } from "../types.js";
import { withoutMakerPrefix } from "./common.js";
import { footerText } from "./words.js";

export type LifecycleReminderContext = {
  title: string;
  deadlineType: "deprecation" | "retirement" | "shutdown";
  deadlineAt: string;
  offsetDays: number;
  replacement: string | null;
  source: string;
  eventId: number;
  url: string;
};

export const lifecycleReminderContextSchema = z.object({
  title: z.string().min(1),
  deadlineType: z.enum(["deprecation", "retirement", "shutdown"]),
  deadlineAt: z.string().datetime({ offset: true }),
  offsetDays: z.number().int().positive(),
  replacement: z.string().nullable(),
  source: z.string().min(1),
  eventId: z.number().int().positive(),
  url: z.url(),
});

export function parseLifecycleReminderContext(value: unknown): LifecycleReminderContext {
  return lifecycleReminderContextSchema.parse(value);
}

function verb(type: LifecycleReminderContext["deadlineType"]): string {
  if (type === "deprecation") return "is deprecated";
  if (type === "shutdown") return "shuts down";
  return "retires";
}

function dayLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

function lines(context: LifecycleReminderContext, event: Event): string[] {
  const evidence = `${sourceLabel(event.source)} · event #${event.id}`;
  return [
    "Lifecycle deadline",
    `${context.title} ${verb(context.deadlineType)} in ${dayLabel(context.offsetDays)}`,
    "",
    "Deadline",
    context.deadlineAt.slice(0, 10),
    ...(context.replacement ? ["", `Replacement: ${context.replacement}`] : []),
    "",
    "Evidence",
    evidence,
    context.url,
  ];
}

export function renderLifecycleReminderText(context: LifecycleReminderContext, event: Event): string {
  return lines(context, event).join("\n");
}

export function renderLifecycleReminderEmbed(context: LifecycleReminderContext, event: Event): Record<string, unknown> {
  const deadline = Math.floor(Date.parse(context.deadlineAt) / 1000);
  return {
    author: { name: "LIFECYCLE DEADLINE" },
    title: `⏳ ${context.title}`.slice(0, 250),
    color: 0xe67e22,
    description: `${context.title} ${verb(context.deadlineType)} in ${dayLabel(context.offsetDays)}.`,
    fields: [
      { name: "Deadline", value: `<t:${deadline}:D> · <t:${deadline}:R>`, inline: true },
      ...(context.replacement
        ? [{ name: "Replacement", value: context.replacement.slice(0, 1024), inline: true }]
        : []),
    ],
    url: context.url,
    footer: { text: footerText(event.source, event.confidence ?? "observed", "evidence") },
  };
}

const NAMES_PER_VENDOR = 3;

/** "text/overall" and "webdev" are keys; the digest names the board a reader knows. */
const BOARD_NAMES: Record<string, string> = {
  webdev: "WebDev",
  "text-to-image": "Text-to-Image",
  "image-edit": "Image Edit",
};
function boardName(board: string): string {
  // A board the source already names ("Arena text", "Intelligence Index") is read as it is.
  if (/arena|index|leaderboard/i.test(board)) return board.replace(/artificial analysis/i, "Artificial Analysis");
  const key = board.replace(/\/overall$/, "").toLowerCase();
  const named = BOARD_NAMES[key] ?? key.replace(/[-_/]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
  return /arena|index|leaderboard/i.test(named) ? named : `${named} Arena`;
}

/**
 * One line per model, at its best effort. "Grok 4.7 (xhigh)" and "Grok 4.7 (high)" scored on the same
 * morning read as two models; the reader wants where Grok 4.7 landed.
 */
function bestEffortOnly<T extends { name: string; index: number }>(entries: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const entry of entries) {
    const model = entry.name.replace(/\s*\([^)]*\)\s*$/, "");
    const held = best.get(model);
    if (!held || entry.index > held.index) best.set(model, entry);
  }
  return entries.filter((entry) => best.get(entry.name.replace(/\s*\([^)]*\)\s*$/, "")) === entry);
}

/**
 * The week, in the order a reader would ask about it: what can I use now, what got cheaper, and
 * what did the people watching early see before anybody announced it.
 */
/**
 * A retirement date in one shape. The catalogues write "09/21/26", "2026-10-16" and "Not sooner
 * than June 9, 2027" in the same list, and three date formats in one line read as three sources
 * rather than one week.
 */
function retirementDay(date: string): string {
  const at = Date.parse(date.replace(/^(?:not sooner than|to be announced|on)\s+/i, ""));
  if (!Number.isFinite(at)) return date;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The recap a destination reads, by the classes it carries; empty when none of its part moved. */
export function renderRecapLines(context: RecapContext, signals: readonly string[]): string[] {
  const day = (at: string) =>
    new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  if (context.period === "news") {
    // The labs' posts are read by the scouts. The wire's reader pays $20 for Codex or Claude, and a
    // morning of essays and customer stories under "Also from the labs" was filler to them.
    if (!signals.includes("codename") || !context.headlines.length) return [];
    const lines = [`**${day(context.from)} → ${day(context.to)}**`];
    // "Also from the labs" is the labs' own posts. A front-page story somebody else wrote is read
    // for the same day and belongs under its own heading: "Alibaba open-sources a medical model"
    // was a Hacker News link filed as something Alibaba had announced.
    for (const [topic, heading, desk] of [
      ["safety", "🛡 **Safety**", null],
      ["research", "🔬 **Research**", null],
      ["other", "🏢 **Also from the labs**", true],
      ["other", "📎 **Elsewhere**", false],
    ] as const) {
      const section = context.headlines.filter((line) => line.topic === topic && (desk === null || line.desk === desk));
      if (!section.length) continue;
      lines.push("", heading);
      for (const line of section)
        lines.push(
          `· **${line.vendor}** — ${line.url ? `[${line.title}](${line.url})` : line.title}${line.more ? ` · +${line.more} more` : ""}${line.summary ? `\n　↳ ${line.summary}` : ""}`,
        );
    }
    return lines;
  }
  if (context.period === "day") {
    // No API prices, for either room: the wire's readers are on a $20 Codex or Claude plan, and the
    // scouts came for what nobody has announced yet. A promotion ending on a published price list is
    // neither. A price for a model not yet out is a sighting of its own.
    const moved = [
      ...(signals.includes("codename")
        ? [
            ...context.leaders.map(
              (leader) => `🏆 ${withoutMakerPrefix(leader.name)} now leads ${boardName(leader.board)}`,
            ),
            ...context.climbers.map(
              (climb) =>
                `📈 ${withoutMakerPrefix(climb.name)} · #${climb.from} → #${climb.to} on ${boardName(climb.board)}`,
            ),
            ...bestEffortOnly(context.indexed).map(
              (entry) =>
                `🧠 ${withoutMakerPrefix(entry.name)} scored ${entry.index.toFixed(1)} on the Intelligence Index${entry.place ? ` · #${entry.place}` : ""}`,
            ),
            ...context.newBoards.map(
              (board) =>
                `🆕 New board: ${boardName(board.board)}${board.leader ? ` · led by ${withoutMakerPrefix(board.leader)}` : ""}`,
            ),
            ...context.resellerArrivals.map(
              (entry) =>
                `🆕 ${entry.name}${entry.maker ? ` · ${entry.maker}` : ""} — now on ${[entry.reseller, ...entry.alsoOn].join(", ")}` +
                // What the catalogue said about this model beyond listing it once per shop, counted
                // rather than repeated: four rows for MAI Image 2.6 was five of eight lines.
                (entry.variants ? ` · +${entry.variants} variant${entry.variants === 1 ? "" : "s"}` : ""),
            ),
            ...context.codeNotes.map((note) => `🔧 ${note.repo}: ${note.text}`),
          ]
        : []),
    ];
    return moved.length ? [`**${day(context.from)} → ${day(context.to)}**`, "", ...moved] : [];
  }
  const lines = [`**${day(context.from)} – ${day(context.to)}**`, ""];
  if (!context.arrivalCount) lines.push("🚀 **No new models this week.**");
  else {
    lines.push(`🚀 **${context.arrivalCount} ${context.arrivalCount === 1 ? "model" : "models"} arrived**`);
    // One line per maker, because a reader scanning this is looking for a name they use.
    let named = 0;
    for (const group of context.arrivals) {
      const shown = group.names.slice(0, NAMES_PER_VENDOR);
      named += group.names.length;
      const rest = group.names.length - shown.length;
      lines.push(`· **${group.vendor}** — ${shown.join(", ")}${rest ? ` +${rest}` : ""}`);
    }
    const others = context.arrivalCount - named;
    if (others > 0) lines.push(`· ${others} more from smaller makers`);
  }
  if (context.retirements.length)
    lines.push(
      `⚠️ **Retiring:** ${context.retirements
        .map((retirement) =>
          retirement.date ? `${retirement.name} (${retirementDay(retirement.date)})` : retirement.name,
        )
        .join(", ")}`,
    );
  // A maker's own sentence stands on its own line; inside the list above it read as a model's name.
  for (const note of context.retirementNotes) lines.push(`⚠️ ${note}`);
  return lines;
}

export function renderRecapEmbed(context: RecapContext, signals: readonly string[]): Record<string, unknown> | null {
  const lines = renderRecapLines(context, signals);
  if (!lines.length) return null;
  // The name and the date are the title; an eyebrow in capitals over a bold date line said it in two
  // voices before the first model.
  const to = new Date(context.to).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const start = new Date(context.from);
  const sameMonth = start.getUTCMonth() === new Date(context.to).getUTCMonth();
  const from = sameMonth
    ? String(start.getUTCDate())
    : start.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const title =
    context.period === "news"
      ? `📰 The day in AI · ${to}`
      : context.period === "day"
        ? `📊 What moved · ${to}`
        : `🗓 The week in models · ${from}${sameMonth ? "–" : " – "}${to}`;
  const body = lines[1] === "" ? lines.slice(2) : lines.slice(1);
  return { title, color: 0x5865f2, description: clip(body.join("\n"), 4000) };
}
