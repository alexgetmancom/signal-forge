import { collectArtificialAnalysis, collectMediaArena, MEDIA_ARENAS } from "../analysis.js";
import { collectArena, collectLeaderboards } from "../arena.js";
import { collectSimpleBench, collectVoxelBench, collectWeirdMl } from "../benchmarks.js";
import { collectDesignArena, DESIGNARENA_CATEGORIES } from "../community.js";
import type { SourceContext, SourceEntry } from "../definition.js";

/**
 * What every table here shares. A public leaderboard is somebody else's measurement of a model,
 * which proves the model can be called by whoever ran the benchmark and nothing more: it never
 * rises above `observed` on its own, and a ranking is never a claim that anything shipped.
 */
const LEADERBOARD = {
  authority: "third_party" as const,
  group: "Arena",
  evidence: "leaderboard" as const,
  confidence: "observed" as const,
};

const arenaSite = { ...LEADERBOARD, upstream: "arena.ai" };

/** Arenas, leaderboards and benchmark tables. */
export function leaderboardsSources({ config, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "arena",
      ...arenaSite,
      // The roster is who is on the arena at all, which is the one thing here that can name a model
      // nothing else has: a model under a codename plays before it is announced.
      evidence: "arena_roster",
      stream: "arena",
      intervalSeconds: config.pollSeconds,
      collector: () => collectArena(),
    },
    {
      id: "arena-leaderboards",
      ...arenaSite,
      stream: "leaderboards",
      intervalSeconds: 1800,
      heavy: true,
      collector: () => collectLeaderboards(),
    },
    ...DESIGNARENA_CATEGORIES.map(
      (category, index): SourceEntry => ({
        id: `designarena:${category}`,
        ...LEADERBOARD,
        stream: "leaderboards",
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
      }),
    ),
    {
      id: "voxelbench",
      ...LEADERBOARD,
      stream: "leaderboards",
      // 1269 score moves in the month to 2026-09-22 and no card: a day still sees a model enter.
      intervalSeconds: 86_400,
      collector: () => collectVoxelBench(fetch, cache),
    },
    {
      id: "weirdml",
      ...LEADERBOARD,
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectWeirdMl(fetch, cache),
    },
    {
      id: "simplebench",
      ...LEADERBOARD,
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectSimpleBench(fetch, cache),
    },
    {
      id: "artificial-analysis",
      ...LEADERBOARD,
      stream: "leaderboards",
      intervalSeconds: 3600,
      capabilityId: "artificial-analysis",
      requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
      // Five sources, one host, one key. Without a pacing group all five fire in the same cycle,
      // and the hourly ones do it every hour: the key was refused on 2026-09-18 and the six issues
      // that followed were all the same request being made five times at once. Every other host
      // this service asks more than once is paced; this one was the exception because the sources
      // were added one at a time and each was alone when it was.
      pace: { group: "artificialanalysis.ai", seconds: 10 },
      collector: () => collectArtificialAnalysis(config),
    },
    ...MEDIA_ARENAS.map(
      (arena): SourceEntry => ({
        id: `artificial-analysis:${arena}`,
        ...LEADERBOARD,
        stream: "leaderboards",
        // The video and image-editing arenas rank a model after its launch: over the month to
        // 2026-09-22 neither was the first to name one or made a card, so a day is early enough.
        intervalSeconds: arena === "text-to-video" || arena === "image-editing" ? 86_400 : 3600,
        capabilityId: "artificial-analysis",
        requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
        pace: { group: "artificialanalysis.ai", seconds: 10 },
        collector: () => collectMediaArena(config, arena),
      }),
    ),
  ];
}
