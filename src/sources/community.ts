import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";

/**
 * Places that publish before the vendors do: a design arena whose board is separate from the text
 * arenas, and an editor whose changelog names models the makers have not announced.
 */

const designArena = z.object({
  success: z.literal(true),
  category: z.string().min(1),
  data: z
    .array(
      z.object({
        modelId: z.string().min(1),
        elo: z.number().nullish(),
        winRate: z.number().nullish(),
        battles: z.number().nullish(),
      }),
    )
    .min(1),
});

/** The categories the models arena actually serves; the site lists others that return 400. */
export const DESIGNARENA_CATEGORIES = ["website", "uicomponent", "image"];

const DESIGNARENA_BOARD_PATHS: Record<string, string> = {
  website: "website",
  uicomponent: "ui-components",
  image: "image",
};

function designArenaLeaderboardUrl(category: string): string {
  return `https://www.designarena.ai/leaderboard/${DESIGNARENA_BOARD_PATHS[category] ?? category}`;
}

/** Same rule as the text leaderboards: only the leading places are news when they move. */
const RANKED_PLACES = 20;

export function parseDesignArena(payload: string, category: string): Collection {
  const board = designArena.parse(JSON.parse(payload));
  if (board.category !== category)
    throw new Error(`DesignArena returned category ${board.category}, expected ${category}`);
  const ranked = [...board.data].sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0));
  return {
    source: `designarena:${category}`,
    stream: "leaderboards",
    url: designArenaLeaderboardUrl(category),
    raw: payload,
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
  // The page renders an entry's heading more than once (a responsive layout ships both variants),
  // so the slug is a key rather than a list item: the same entry twice is one entry.
  const seen = new Map<string, { slug: string; title: string; published: string | null }>();
  for (const match of html.matchAll(heading)) {
    const [, slug, title] = match;
    if (!slug || !title || seen.has(slug)) continue;
    const dates = [...html.slice(0, match.index).matchAll(/dateTime="([^"]+)"/g)];
    seen.set(slug, { slug, title: title.trim(), published: dates.at(-1)?.[1] ?? null });
  }
  const records = [...seen.values()];
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
