import { z } from "zod";
import type { RecapContext } from "../../recap.js";
import { sourceLabel } from "../../sources/labels.js";
import { eventEvidenceType, evidenceLabel } from "../confidence.js";
import type { Event } from "../types.js";

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
  const body = lines(context, event);
  const evidenceType = eventEvidenceType(event);
  return {
    author: { name: "LIFECYCLE DEADLINE" },
    title: context.title.slice(0, 250),
    description: body.slice(1, -1).join("\n").slice(0, 4000),
    url: context.url,
    footer: { text: `Evidence: ${evidenceLabel(evidenceType)} · event #${event.id}` },
  };
}

const NAMES_PER_VENDOR = 3;

/**
 * A price move in the terms a reader pays it in: a cut as the share that came off, a rise as the
 * multiple it became once it is more than a doubling. "Up 74%" for a price that nearly quadrupled
 * is arithmetic nobody is charged.
 */
function priceMove(move: { percent: number; cheaper: boolean; discountEnded?: boolean }): string {
  if (move.cheaper) return `down ${Math.round(move.percent * 100)}%`;
  const rise =
    move.percent >= 1 ? `${(move.percent + 1).toFixed(1)}× more expensive` : `up ${Math.round(move.percent * 100)}%`;
  return move.discountEnded ? `launch pricing ended · ${rise}` : rise;
}

/**
 * The week, in the order a reader would ask about it: what can I use now, what got cheaper, and
 * what did the people watching early see before anybody announced it.
 */
export function renderRecapLines(context: RecapContext): string[] {
  const day = (at: string) =>
    new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  if (context.period === "day") {
    const moved = [
      ...context.priceMoves.map((move) => `📊 ${move.name} · ${priceMove(move)}`),
      ...context.leaders.map((leader) => `🏆 ${leader.name} now leads ${leader.board}`),
    ];
    return [`**${day(context.from)} → ${day(context.to)}**`, "", ...moved];
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
  for (const move of context.priceMoves) lines.push(`📊 ${move.name} · ${priceMove(move)}`);
  if (context.codenameCount)
    lines.push(
      `🕵 **${context.codenameCount} early ${context.codenameCount === 1 ? "sighting" : "sightings"}** in scouts, before any announcement`,
    );
  return lines;
}

export function renderRecapEmbed(context: RecapContext): Record<string, unknown> {
  return {
    author: { name: context.period === "day" ? "WHAT MOVED" : "THE WEEK IN MODELS" },
    title: context.period === "day" ? "Daily moves" : "Weekly recap",
    description: renderRecapLines(context).join("\n").slice(0, 4000),
    footer: {
      text:
        context.period === "day"
          ? "Moves too small for a card of their own · no ping"
          : "Everything here was posted as it happened · scouts saw the early half first",
    },
  };
}
