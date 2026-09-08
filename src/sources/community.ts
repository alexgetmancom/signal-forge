import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
import { fetchText } from "./http.js";

/**
 * Places that publish before the vendors do: a Chinese registry where the weights land first, a
 * design arena whose board is separate from the text arenas, and an editor whose changelog names
 * models the makers have not announced.
 */

const modelScope = z.object({
  Data: z.object({
    Models: z
      .array(
        z.object({
          Path: z.string().min(1),
          Name: z.string().min(1),
          ChineseName: z.string().nullish(),
          CreatedTime: z.number().nullish(),
          Tasks: z.array(z.object({ Name: z.string() })).nullish(),
        }),
      )
      .nullable(),
  }),
});

/** Organisations that ship on ModelScope; the global feed is mostly private user uploads. */
export const MODELSCOPE_PATHS = ["Qwen", "deepseek-ai", "MiniMax", "ZhipuAI", "moonshotai"];

export function parseModelScope(payload: string, path: string): Collection {
  const models = modelScope.parse(JSON.parse(payload)).Data.Models ?? [];
  return {
    source: `modelscope:${path}`,
    stream: "weights",
    url: `https://modelscope.cn/organization/${path}`,
    raw: payload,
    // Same reasoning as Hugging Face: this is a newest-first page, so an absent repository is a
    // paging artefact rather than a deletion.
    appendOnly: true,
    records: models.map((model) => ({
      id: `${model.Path}/${model.Name}`,
      name: `${model.Path}/${model.Name}`,
      url: `https://modelscope.cn/models/${model.Path}/${model.Name}`,
      maker: model.Path,
      category: model.Tasks?.[0]?.Name ?? null,
    })),
  };
}

export async function collectModelScope(path: string, request: Fetch = fetch): Promise<Collection> {
  const payload = await fetchText(
    "https://modelscope.cn/api/v1/models",
    { accept: "application/json", "content-type": "application/json" },
    request,
    { method: "PUT", body: JSON.stringify({ Path: path, PageSize: 30, PageNumber: 1, SortBy: "GmtCreated" }) },
  );
  return parseModelScope(payload, path);
}

const designArena = z.object({
  success: z.literal(true),
  category: z.string().min(1),
  data: z.array(
    z.object({
      modelId: z.string().min(1),
      elo: z.number().nullish(),
      winRate: z.number().nullish(),
      battles: z.number().nullish(),
    }),
  ),
});

/** The categories the models arena actually serves; the site lists others that return 400. */
export const DESIGNARENA_CATEGORIES = ["website", "gamedev", "image", "logo", "svg", "uicomponent", "dataviz"];

/** Same rule as the text leaderboards: only the leading places are news when they move. */
const RANKED_PLACES = 20;

export function parseDesignArena(payload: string, category: string): Collection {
  const board = designArena.parse(JSON.parse(payload));
  const ranked = [...board.data].sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0));
  return {
    source: `designarena:${category}`,
    stream: "leaderboards",
    url: `https://www.designarena.ai/leaderboard?category=${category}`,
    raw: payload,
    appendOnly: true,
    trackChanges: true,
    records: ranked.map((model, index) => ({
      id: model.modelId,
      name: model.modelId,
      category: `designarena/${category}`,
      // Elo and battle counts tick on every vote. Storing them would make every poll an event, so
      // only the position is kept, and only where a position is worth reporting.
      ...(index < RANKED_PLACES ? { rank: index + 1 } : {}),
    })),
  };
}

export async function collectDesignArena(category: string, request: Fetch = fetch): Promise<Collection> {
  const payload = await fetchText(
    "https://www.designarena.ai/api/leaderboard",
    { accept: "application/json", "content-type": "application/json" },
    request,
    { method: "POST", body: JSON.stringify({ arenaType: "models", category }) },
  );
  return parseDesignArena(payload, category);
}

/**
 * Cursor publishes its changelog as a rendered page with no feed. Entries are addressed by slug,
 * so the slug is the identity and the surrounding text supplies a title and a date.
 */
export function parseCursorChangelog(html: string): Collection {
  // Each entry is a heading that links to its own slug, preceded by the machine-readable date of
  // that entry. Anchoring on the heading avoids the navigation and image links that carry the same
  // slug but no title.
  const heading = /<h1[^>]*>\s*<a[^>]*href="\/changelog\/([a-z0-9.-]+)"[^>]*>([^<]{3,200})<\/a>/g;
  const records: { slug: string; title: string; published: string | null }[] = [];
  for (const match of html.matchAll(heading)) {
    const [, slug, title] = match;
    if (!slug || !title) continue;
    const dates = [...html.slice(0, match.index).matchAll(/dateTime="([^"]+)"/g)];
    records.push({ slug, title: title.trim(), published: dates.at(-1)?.[1] ?? null });
  }
  if (!records.length) throw new Error("Public page no longer exposes changelog entries");
  return {
    source: "cursor-changelog",
    stream: "news",
    url: "https://cursor.com/changelog",
    raw: records,
    // The page shows a window of recent entries; older ones scroll off and have not been retracted.
    appendOnly: true,
    records: records.map((entry) => ({
      id: entry.slug,
      name: entry.title,
      url: `https://cursor.com/changelog/${entry.slug}`,
      maker: "Cursor",
      published: entry.published,
    })),
  };
}

export async function collectCursorChangelog(request: Fetch = fetch): Promise<Collection> {
  return parseCursorChangelog(await fetchText("https://cursor.com/changelog", {}, request));
}
