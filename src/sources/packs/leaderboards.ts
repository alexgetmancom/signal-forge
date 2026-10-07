import { collectArtificialAnalysis, collectMediaArena, MEDIA_ARENAS } from "../analysis.js";
import { collectArena, collectLeaderboards } from "../arena.js";
import { collectSimpleBench, collectVoxelBench, collectWeirdMl } from "../benchmarks.js";
import { collectDesignArena, DESIGNARENA_CATEGORIES } from "../community.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";

/**
 * Somebody else's measurement of a model, published as a table: a ranking, a benchmark, an arena.
 *
 * A public leaderboard proves the model can be called by whoever ran the benchmark and nothing more:
 * it never rises above `observed` on its own, and a ranking is never a claim that anything shipped.
 * The arena's roster is the one table that does not fit -- it is who plays at all, and can name a
 * model nothing else has -- so it keeps its own declaration beside this.
 *
 * Hourly is the pace of most of them, and the members that rank a model after its launch or cost
 * more overrule it. The two hosts asked more than once say so in their own pacing group.
 */
const LEADERBOARD: SourceKind = {
  kind: "leaderboard",
  authority: "third_party",
  evidence: "leaderboard",
  confidence: "observed",
  group: "Arena",
  stream: "leaderboards",
  intervalSeconds: 3600,
};

/** Arenas, leaderboards and benchmark tables. */
export function leaderboardsSources({ config, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "arena",
      authority: "third_party",
      upstream: "arena.ai",
      // The roster is who is on the arena at all, which is the one thing here that can name a model
      // nothing else has: a model under a codename plays before it is announced.
      evidence: "arena_roster",
      confidence: "observed",
      group: "Arena",
      stream: "arena",
      intervalSeconds: config.defaultIntervalSeconds,
      collector: () => collectArena(),
    },
    ...sourcesOfKind(LEADERBOARD, [
      {
        id: "arena-leaderboards",
        upstream: "arena.ai",
        intervalSeconds: 1800,
        heavy: true,
        collector: () => collectLeaderboards(),
      },
      ...DESIGNARENA_CATEGORIES.map((category, index) => ({
        id: `designarena:${category}`,
        intervalSeconds: 3600 + index * 120,
        pace: { group: "designarena.ai", seconds: 60 },
        collector: () => collectDesignArena(category),
      })),
      {
        id: "voxelbench",
        // 1269 score moves in the month to 2026-09-22 and no card: a day still sees a model enter.
        intervalSeconds: 86_400,
        collector: () => collectVoxelBench(fetch, cache),
      },
      { id: "weirdml", collector: () => collectWeirdMl(fetch, cache) },
      { id: "simplebench", collector: () => collectSimpleBench(fetch, cache) },
      {
        id: "artificial-analysis",
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
      ...MEDIA_ARENAS.map((arena) => ({
        id: `artificial-analysis:${arena}`,
        // The video and image-editing arenas rank a model after its launch: over the month to
        // 2026-09-22 neither was the first to name one or made a card, so six hours is early enough.
        //
        // A day was, and it was the wrong unit on this host. artificialanalysis.ai resets about a
        // fifth of the connections made to it -- every arena here measured between 17 and 38 per
        // cent over the seven days to 2026-10-03 -- and the hourly arenas absorb that inside an
        // hour. At a day, the same rate is three failed attempts in a row and 87 hours without a
        // read, which is what `text-to-video` was doing: an error in `issues` about a source whose
        // upstream was merely flaky. Six hours asks four times for what a day asked once and keeps
        // a lost read from becoming a lost day.
        intervalSeconds: arena === "text-to-video" || arena === "image-editing" ? 21_600 : 3600,
        capabilityId: "artificial-analysis",
        requiredCapabilities: ["ARTIFICIAL_ANALYSIS_API_KEY"] as const,
        pace: { group: "artificialanalysis.ai", seconds: 10 },
        collector: () => collectMediaArena(config, arena),
      })),
    ]),
  ];
}
