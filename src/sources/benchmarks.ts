import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Independent leaderboards. None of these can break news — every model here was already released
 * somewhere this feed watches — but a ranking is the second witness that turns a claim about a
 * model into a measured fact, and a model appearing on a board is public evidence that somebody
 * outside the lab can run it.
 *
 * Only boards that publish the numbers they render are here. A leaderboard whose figures exist
 * only after its own JavaScript has run would have to be scraped from rendered markup, which
 * breaks on a style change and reports a layout edit as a ranking move.
 *
 * `rank` is deliberately not a record field. A board reorders whenever anyone below moves, so
 * storing the position would emit a change for every model each time one of them is measured;
 * the score is the reading, and rank is derived from it.
 */

// The board answers with ten models unless asked for more; the ceiling is the whole leaderboard,
// which is smaller than this and so is returned in full.
const VOXELBENCH_API_URL = "https://voxelbench.ai/api/leaderboard?limit=200";
const VOXELBENCH_URL = "https://voxelbench.ai/leaderboard";
const WEIRDML_CSV_URL = "https://htihle.github.io/data/weirdml_data.csv";
const WEIRDML_URL = "https://htihle.github.io/weirdml.html";
const SIMPLEBENCH_DATA_URL = "https://simple-bench.com/static/js/leaderboard-data.js";
const SIMPLEBENCH_URL = "https://simple-bench.com/";

function leaderboardCollection(source: string, url: string, raw: unknown, records: RecordData[]): Collection {
  if (!records.length) throw new Error(`${source}: leaderboard listed no models`);
  return { source, stream: "leaderboards", url, raw, trackChanges: true, records };
}

const voxelbenchSchema = z.object({
  leaderboard: z
    .array(
      z.object({
        modelName: z.string().min(1),
        modelSlug: z.string().min(1),
        rating: z.number(),
        gamesPlayed: z.number().nullish(),
        winRate: z.union([z.string(), z.number()]).nullish(),
      }),
    )
    .min(1),
});

export function parseVoxelBench(payload: string): Collection {
  const raw: unknown = JSON.parse(payload);
  return leaderboardCollection(
    "voxelbench",
    VOXELBENCH_URL,
    raw,
    voxelbenchSchema.parse(raw).leaderboard.map((entry) => ({
      id: entry.modelSlug,
      name: entry.modelName,
      modelKey: entry.modelSlug,
      category: "voxelbench/elo",
      score: entry.rating,
      ...(entry.gamesPlayed === null || entry.gamesPlayed === undefined ? {} : { votes: entry.gamesPlayed }),
    })),
  );
}

/**
 * WeirdML publishes the table its page draws from as a CSV. Only the headline accuracy is kept:
 * the per-task columns are the same measurement split eighteen ways and would turn one re-run
 * into eighteen changes.
 */
const weirdmlRowSchema = z.object({
  internal_model_name: z.string().min(1),
  display_name: z.string().min(1),
  avg_acc: z.string().min(1),
  release_date: z.string().nullish(),
  model_slug: z.string().nullish(),
});

function parseCsv(payload: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index];
    if (quoted) {
      if (character === '"' && payload[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (character !== "\r") value += character;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header?.length) throw new Error("weirdml: CSV had no header row");
  return rows
    .filter((entry) => entry.some((cell) => cell.trim()))
    .map((entry) => Object.fromEntries(header.map((name, index) => [name.trim(), (entry[index] ?? "").trim()])));
}

export function parseWeirdMl(payload: string): Collection {
  const rows = parseCsv(payload);
  const records = rows.map((row) => {
    const entry = weirdmlRowSchema.parse(row);
    const accuracy = Number.parseFloat(entry.avg_acc);
    if (!Number.isFinite(accuracy)) throw new Error(`weirdml: ${entry.display_name} has no readable accuracy`);
    return {
      id: entry.internal_model_name,
      name: entry.display_name,
      modelKey: entry.model_slug || entry.internal_model_name,
      category: "weirdml/average-accuracy",
      // The CSV carries a fraction; every other board in this feed reports a percentage.
      score: Math.round(accuracy * 1_000) / 10,
      ...(entry.release_date ? { released: entry.release_date } : {}),
    } satisfies RecordData;
  });
  return leaderboardCollection("weirdml", WEIRDML_URL, { rows: rows.length }, records);
}

/**
 * SimpleBench ships its table as a JavaScript array literal rather than JSON, so the fields are
 * read individually. A quoted field cannot contain a quote here, and a row that does not parse is
 * an upstream change worth failing on rather than a row to skip.
 */
const simplebenchRowSchema = z.object({
  model: z.string().min(1),
  score: z.string().regex(/^\d+(?:\.\d+)?%$/),
  organization: z.string(),
  dateAdded: z.string().nullable(),
});

export function parseSimpleBench(payload: string): Collection {
  const body = payload.match(/const\s+leaderboardData\s*=\s*\[([\s\S]*?)\];/)?.[1];
  if (!body) throw new Error("simplebench: page no longer exposes leaderboardData");
  const records = [...body.matchAll(/\{([^{}]*)\}/g)].flatMap((match) => {
    const fields = match[1] ?? "";
    const read = (name: string): string | null => {
      const found = fields.match(new RegExp(`\\b${name}\\s*:\\s*(?:"([^"]*)"|(null))`));
      if (!found) return null;
      return found[2] === "null" ? null : (found[1] ?? null);
    };
    const entry = simplebenchRowSchema.parse({
      model: read("model") ?? "",
      score: read("score") ?? "",
      organization: read("organization") ?? "",
      dateAdded: read("dateAdded"),
    });
    // The human baselines are the board's reference lines, not models this feed tracks.
    if (/human/i.test(entry.model)) return [];
    return [
      {
        id: entry.model,
        name: entry.model,
        modelKey: entry.model,
        category: "simplebench/score",
        score: Number.parseFloat(entry.score),
        ...(entry.organization ? { maker: entry.organization } : {}),
        ...(entry.dateAdded ? { released: entry.dateAdded } : {}),
      } satisfies RecordData,
    ];
  });
  return leaderboardCollection("simplebench", SIMPLEBENCH_URL, { entries: records.length }, records);
}

export async function collectVoxelBench(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseVoxelBench(
    await fetchText(VOXELBENCH_API_URL, { accept: "application/json" }, request, undefined, cache),
  );
}
export async function collectWeirdMl(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseWeirdMl(await fetchText(WEIRDML_CSV_URL, { accept: "text/csv" }, request, undefined, cache));
}
export async function collectSimpleBench(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  return parseSimpleBench(await fetchText(SIMPLEBENCH_DATA_URL, {}, request, undefined, cache));
}
