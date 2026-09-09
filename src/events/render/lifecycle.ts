import { z } from "zod";
import { sourceLabel } from "../../sources/labels.js";
import { evidenceLabel, evidenceTypeFor } from "../confidence.js";
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
  const evidenceType = event.evidence_type ?? evidenceTypeFor(event.source, event.stream);
  return {
    author: { name: "LIFECYCLE DEADLINE" },
    title: context.title.slice(0, 250),
    description: body.slice(1, -1).join("\n").slice(0, 4000),
    url: context.url,
    footer: { text: `Evidence: ${evidenceLabel(evidenceType)} · event #${event.id}` },
  };
}
