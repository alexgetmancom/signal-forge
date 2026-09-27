import { z } from "zod";
import type { Collection } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { nextData } from "./html.js";
import { fetchText } from "./http.js";
import { parseEachEntry } from "./schema.js";

const arenaCatalog = z.object({
  arena: z.string(),
  complete: z.literal(true),
  models: z.array(z.unknown()).min(1),
});
const REQUIRED_ARENAS = ["text", "code", "text-to-image", "search", "text-to-video", "document"];

const arenaModel = z.object({
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
});
export function parseArena(payload: string): Collection {
  const catalogs = parseEachEntry(arenaCatalog, JSON.parse(payload), "arena catalog");
  const arenas = new Set(catalogs.map((catalog) => catalog.arena));
  if (arenas.size !== catalogs.length || REQUIRED_ARENAS.some((arena) => !arenas.has(arena)))
    throw new SourceError("schema", "Arena model catalog is missing or duplicating an arena");
  const models = parseEachEntry(
    arenaModel,
    catalogs.flatMap((catalog) => catalog.models),
    "arena models",
  );
  // The same model appears in several arenas; only its rank differs between those copies.
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  const records = unique.map((m) => ({
    id: m.id,
    name: m.displayName,
    model: m.name ?? m.displayName,
    maker: m.organization ?? null,
    provider: m.provider ?? null,
    selectable: m.userSelectable,
    input: m.capabilities.inputCapabilities,
    output: m.capabilities.outputCapabilities,
  }));
  return {
    source: "arena",
    stream: "arena",
    url: "https://arena.ai",
    raw: records,
    records,
  };
}
export async function collectArena(request: Fetch = fetch): Promise<Collection> {
  return parseArena(
    await fetchText("https://arena.ai/nextjs-api/model-catalog", { accept: "application/json" }, request),
  );
}
const leaderboardBoard = z.object({
  arenaSlug: z.string(),
  leaderboardSlug: z.string(),
  voteCutoffISOString: z.string().datetime({ offset: true }).nullish(),
  entries: z
    .array(
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
    )
    .min(1),
});
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

/**
 * A board position never becomes a metric, whatever the board calls it.
 *
 * The sweep below collects every numeric field the board did not name, which is how price and
 * context length arrive without a parser change each time. It also carried `rankLower`,
 * `rankUpper` and `rankStyleControl` straight back in, and those are positions: they move whenever
 * anyone below moves, which is the reason a rank is not stored in the first place. Measured
 * 2026-09-14 on production, 188 of 877 change events on this source were nothing but those bounds
 * shifting. `RANKED_PLACES` and the interval-overlap test both read `rank` and `score`, so neither
 * ever saw them.
 */
function rankMetric(key: string): boolean {
  return /^rank/i.test(key);
}

function dynamicMetrics(entry: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of ["metrics", "dimensions", "scores"]) {
    const value = entry[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [metric, score] of Object.entries(value))
      if (scalarMetric(score) && !rankMetric(metric)) metrics[metric] = score;
  }
  for (const [key, value] of Object.entries(entry))
    if (
      !LEADERBOARD_ENTRY_FIELDS.has(key) &&
      !["metrics", "dimensions", "scores"].includes(key) &&
      !rankMetric(key) &&
      scalarMetric(value)
    )
      metrics[key] = value as number;
  return Object.fromEntries(Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right)));
}

/** The old summary carried the first 200 places; deeper rows have never been sightings here. */
const MAX_BOARD_ENTRIES = 200;

function recordsFromBoards(data: LeaderboardBoard[]): Collection["records"] {
  return data.flatMap((b) =>
    [...b.entries]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, MAX_BOARD_ENTRIES)
      .map((m) => {
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

/** How far down a board a movement is still worth a message. */
const RANKED_PLACES = 20;

const BOARD_PAGES = [
  ["text", "text/overall"],
  ["code/webdev", "code/overall"],
  ["code/image-to-webdev", "image-to-code/overall"],
  ["document", "document/overall"],
  ["image-edit", "image-edit/overall"],
  ["image-to-video", "image-to-video/overall"],
  ["search", "search/overall"],
  ["text-to-image", "text-to-image/overall"],
  ["text-to-video", "text-to-video/overall"],
  ["video-edit", "video-to-video/overall"],
  ["vision", "vision/overall"],
] as const;

export function parseLeaderboards(pages: readonly { path: string; html: string }[]): Collection {
  const data = parseEachEntry(
    leaderboardBoard,
    pages.map((page) => nextData(page.html, "leaderboard")),
    "arena leaderboards",
  );
  for (const [index, board] of data.entries()) {
    const expected = BOARD_PAGES.find(([path]) => path === pages[index]?.path)?.[1];
    if (!expected || `${board.arenaSlug}/${board.leaderboardSlug}` !== expected)
      throw new SourceError("schema", "Arena leaderboard page returned the wrong category");
  }
  const records = recordsFromBoards(data);
  return {
    source: "arena-leaderboards",
    stream: "leaderboards",
    url: "https://arena.ai/leaderboard",
    raw: records,
    // The rank is the only field that moves, and it was parsed but never stored, so a climb or a
    // fall was invisible. Tracking it is what makes "up two places" reportable at all.
    //
    // Only the leading places carry a rank. Below them a board reshuffles constantly and nobody
    // reports it, so storing those numbers would buy a stream of events and no news. Entering or
    // leaving the leading places still shows up, because the rank appears or disappears. The
    // source returns a complete snapshot, so a model missing from two successful snapshots is
    // treated as having left the board.
    trackChanges: true,
    records,
  };
}
export async function collectLeaderboards(request: Fetch = fetch): Promise<Collection> {
  const pages: { path: string; html: string }[] = [];
  for (const [path] of BOARD_PAGES)
    pages.push({ path, html: await fetchText(`https://arena.ai/leaderboard/${path}`, {}, request) });
  return parseLeaderboards(pages);
}
