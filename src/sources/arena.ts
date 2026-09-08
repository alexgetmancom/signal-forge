import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
import { fetchText } from "./http.js";

export function nextData(html: string, key: string): unknown {
  let stream = "";
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/g)) {
    const chunk: unknown = JSON.parse(match[1] ?? "null");
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") stream += chunk[1];
  }
  const search = (value: unknown): unknown => {
    if (value && typeof value === "object") {
      if (!Array.isArray(value) && Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key];
      for (const nested of Object.values(value)) {
        const found = search(nested);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const line of stream.split("\n")) {
    const text = line.slice(line.indexOf(":") + 1);
    if (!text.startsWith("[") && !text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const found = search(parsed);
    if (found !== undefined) return found;
  }
  throw new Error(`Public page no longer exposes ${key}`);
}
const arenaModels = z
  .array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      displayName: z.string(),
      organization: z.string().nullable().optional(),
      provider: z.string().nullable().optional(),
      userSelectable: z.boolean(),
      capabilities: z.object({
        inputCapabilities: z.record(z.string(), z.unknown()),
        outputCapabilities: z.record(z.string(), z.unknown()),
      }),
    }),
  )
  .min(1);
export function parseArena(html: string): Collection {
  const raw = nextData(html, "initialModels"),
    models = arenaModels.parse(raw);
  return {
    source: "arena",
    stream: "arena",
    url: "https://arena.ai",
    raw,
    records: models.map((m) => ({
      id: m.id,
      name: m.displayName,
      model: m.name ?? m.displayName,
      maker: m.organization ?? null,
      provider: m.provider ?? null,
      selectable: m.userSelectable,
      input: m.capabilities.inputCapabilities,
      output: m.capabilities.outputCapabilities,
    })),
  };
}
export async function collectArena(request: Fetch = fetch): Promise<Collection> {
  return parseArena(await fetchText("https://arena.ai", {}, request));
}
const boards = z
  .array(
    z.object({
      arenaSlug: z.string(),
      leaderboardSlug: z.string(),
      entries: z.array(
        z.object({
          modelKey: z.string(),
          modelDisplayName: z.string(),
          modelOrganization: z.string().nullable(),
          rank: z.number(),
        }),
      ),
    }),
  )
  .min(1);
export function parseLeaderboards(html: string): Collection {
  const raw = nextData(html, "leaderboards"),
    data = boards.parse(raw);
  return {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw,
    appendOnly: true,
    records: data.flatMap((b) =>
      b.entries.map((m) => ({
        id: `${b.arenaSlug}:${b.leaderboardSlug}:${m.modelKey}`,
        name: m.modelDisplayName,
        category: `${b.arenaSlug}/${b.leaderboardSlug}`,
        maker: m.modelOrganization,
      })),
    ),
  };
}
export async function collectLeaderboards(request: Fetch = fetch): Promise<Collection> {
  return parseLeaderboards(await fetchText("https://arena.ai/leaderboard", {}, request));
}
