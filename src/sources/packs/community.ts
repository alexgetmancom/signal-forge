import { collectCodexModels } from "../codex.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectGithubDiscovery, collectHuggingFaceTrending, GITHUB_DISCOVERY_QUERIES } from "../discovery.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "../github.js";
import { collectPolymarket } from "../markets.js";
import { collectMimoTraining } from "../training.js";

/** GitHub repositories and discovery: what third parties publish before any vendor says so. */
export function communitySources({ db, config, cache }: SourceContext): SourceEntry[] {
  const definitions: SourceEntry[] = [
    {
      id: "mimo-training",
      authority: "first_party",
      vendor: "Xiaomi",
      group: "Discovery",
      stream: "training",
      intervalSeconds: 1800,
      collector: () => collectMimoTraining(),
    },
    {
      id: "polymarket",
      authority: "third_party",
      group: "Discovery",
      stream: "markets",
      // Prices move all day and the record only keeps five-point buckets, so a slower poll would
      // read the same numbers; an hour is what the other discovery sources run at.
      intervalSeconds: 3600,
      pace: { group: "polymarket.com", seconds: 60 },
      collector: () => collectPolymarket(fetch, cache),
    },
    {
      id: "codex-models",
      authority: "vendor_owned",
      vendor: "OpenAI",
      group: "GitHub",
      stream: "github",
      intervalSeconds: 1800,
      collector: () => collectCodexModels(fetch, cache),
    },
  ];

  for (const watch of config.github) {
    const authority = watch.repo.startsWith("deepseek-ai/") ? "vendor_owned" : "third_party";
    definitions.push(
      {
        id: `github:${watch.repo}:pulls`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubPulls(db, config, watch, fetch, cache),
      },
      {
        id: `github:${watch.repo}:commits`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubCommits(db, config, watch, fetch, cache),
      },
      {
        id: `github:${watch.repo}:releases`,
        authority,
        group: "GitHub",
        stream: "github",
        intervalSeconds: 1800,
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
      },
    );
  }

  for (const query of GITHUB_DISCOVERY_QUERIES) {
    definitions.push({
      id: `discovery:github-${query.id}`,
      authority: "third_party",
      group: "Discovery",
      stream: "github",
      intervalSeconds: 3600,
      requiredCapabilities: ["GITHUB_TOKEN"],
      pace: { group: "github-search", seconds: 60 },
      collector: () => collectGithubDiscovery(config, query, fetch, new Date(), cache),
    });
  }
  definitions.push({
    id: "discovery:huggingface-trending",
    authority: "third_party",
    group: "Discovery",
    stream: "weights",
    // The list moves with likes over days, so an hour is early enough to see a model enter it.
    intervalSeconds: 3600,
    pace: { group: "huggingface.co", seconds: 60 },
    collector: () => collectHuggingFaceTrending(config, fetch, cache, new Date()),
  });

  return definitions;
}
