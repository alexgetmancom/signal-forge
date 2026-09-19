import { collectArtificialAnalysis, collectMediaArena, MEDIA_ARENAS } from "../analysis.js";
import { collectArena, collectLeaderboards } from "../arena.js";
import { collectSimpleBench, collectVoxelBench, collectWeirdMl } from "../benchmarks.js";
import { collectDesignArena, DESIGNARENA_CATEGORIES } from "../community.js";
import type { SourceContext, SourceEntry } from "../definition.js";

/** Arenas, leaderboards and benchmark tables. */
export function leaderboardsSources({ config, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "arena",
      authority: "third_party",
      group: "Arena",
      stream: "arena",
      intervalSeconds: config.pollSeconds,
      collector: () => collectArena(),
    },
    {
      id: "arena-leaderboards",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 1800,
      collector: () => collectLeaderboards(),
    },
    ...DESIGNARENA_CATEGORIES.map(
      (category, index): SourceEntry => ({
        id: `designarena:${category}`,
        authority: "third_party",
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
      }),
    ),
    {
      id: "voxelbench",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectVoxelBench(fetch, cache),
    },
    {
      id: "weirdml",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectWeirdMl(fetch, cache),
    },
    {
      id: "simplebench",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      collector: () => collectSimpleBench(fetch, cache),
    },
    {
      id: "artificial-analysis",
      authority: "third_party",
      group: "Arena",
      stream: "leaderboards",
      intervalSeconds: 3600,
      capabilityId: "artificial-analysis",
      requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
      collector: () => collectArtificialAnalysis(config),
    },
    ...MEDIA_ARENAS.map(
      (arena): SourceEntry => ({
        id: `artificial-analysis:${arena}`,
        authority: "third_party",
        group: "Arena",
        stream: "leaderboards",
        intervalSeconds: 3600,
        capabilityId: "artificial-analysis",
        requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"],
        collector: () => collectMediaArena(config, arena),
      }),
    ),
  ];
}
