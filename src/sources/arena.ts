import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
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
const leaderboardBoard = z.object({
  arenaSlug: z.string(),
  leaderboardSlug: z.string(),
  voteCutoffISOString: z.string().datetime({ offset: true }).nullish(),
  entries: z.array(
    z
      .object({
        modelKey: z.string(),
        modelDisplayName: z.string(),
        modelOrganization: z.string().nullable(),
        rank: z.number(),
        rating: z.number().nullish(),
        ratingUpper: z.number().nullish(),
        ratingLower: z.number().nullish(),
        votes: z.number().int().nonnegative().nullish(),
        modelUrl: z.string().url().nullish(),
        license: z.string().nullish(),
      })
      .passthrough(),
  ),
});
const boards = z.array(leaderboardBoard).min(1);
type LeaderboardBoard = z.infer<typeof leaderboardBoard>;

const LEADERBOARD_ENTRY_FIELDS = new Set([
  "modelKey",
  "modelDisplayName",
  "modelOrganization",
  "rank",
  "rating",
  "ratingUpper",
  "ratingLower",
  "votes",
  "modelUrl",
  "license",
]);

function scalarMetric(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function dynamicMetrics(entry: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of ["metrics", "dimensions", "scores"]) {
    const value = entry[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [metric, score] of Object.entries(value)) if (scalarMetric(score)) metrics[metric] = score;
  }
  for (const [key, value] of Object.entries(entry))
    if (!LEADERBOARD_ENTRY_FIELDS.has(key) && !["metrics", "dimensions", "scores"].includes(key) && scalarMetric(value))
      metrics[key] = value as number;
  return Object.fromEntries(Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right)));
}

function recordsFromBoards(data: LeaderboardBoard[]): Collection["records"] {
  return data.flatMap((b) =>
    b.entries.map((m) => {
      const metrics = dynamicMetrics(m);
      return {
        id: `${b.arenaSlug}:${b.leaderboardSlug}:${m.modelKey}`,
        name: m.modelDisplayName,
        category: `${b.arenaSlug}/${b.leaderboardSlug}`,
        modelKey: m.modelKey,
        ...(m.rank <= RANKED_PLACES ? { rank: m.rank } : {}),
        ...(m.rating !== null && m.rating !== undefined ? { score: m.rating } : {}),
        ...(m.ratingUpper !== null && m.ratingUpper !== undefined ? { scoreUpper: m.ratingUpper } : {}),
        ...(m.ratingLower !== null && m.ratingLower !== undefined ? { scoreLower: m.ratingLower } : {}),
        ...(m.votes !== null && m.votes !== undefined ? { votes: m.votes } : {}),
        ...(m.modelUrl ? { url: m.modelUrl } : {}),
        ...(m.license ? { license: m.license } : {}),
        ...(b.voteCutoffISOString ? { sampledAt: b.voteCutoffISOString } : {}),
        ...(Object.keys(metrics).length ? { metrics } : {}),
        maker: m.modelOrganization,
      };
    }),
  );
}

export function leaderboardRecordsFromRaw(raw: unknown): Collection["records"] {
  return recordsFromBoards(boards.parse(raw));
}
/** How far down a board a movement is still worth a message. */
const RANKED_PLACES = 20;

export function parseLeaderboards(html: string): Collection {
  const raw = nextData(html, "leaderboards"),
    data = boards.parse(raw);
  return {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw,
    // The rank is the only field that moves, and it was parsed but never stored, so a climb or a
    // fall was invisible. Tracking it is what makes "up two places" reportable at all.
    //
    // Only the leading places carry a rank. Below them a board reshuffles constantly and nobody
    // reports it, so storing those numbers would buy a stream of events and no news. Entering or
    // leaving the leading places still shows up, because the rank appears or disappears. The
    // source returns a complete snapshot, so a model missing from two successful snapshots is
    // treated as having left the board.
    trackChanges: true,
    records: recordsFromBoards(data),
  };
}
export async function collectLeaderboards(request: Fetch = fetch): Promise<Collection> {
  return parseLeaderboards(await fetchText("https://arena.ai/leaderboard", {}, request));
}
