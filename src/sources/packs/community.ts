import type { AppConfig } from "../../config.js";
import { collectCodexModels } from "../codex.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectGithubDiscovery, collectHuggingFaceTrending, GITHUB_DISCOVERY_QUERIES } from "../discovery.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "../github.js";
import { collectPolymarket } from "../markets.js";
import { collectModelMentions, MODEL_MENTION_REPOS, mentionSource } from "../modelMentions.js";
import { collectMimoTraining } from "../training.js";

/**
 * Where a vendor writes a model's identifier down for a machine, before it writes anything for a
 * reader.
 *
 * Neither of these is a blog. An API specification and a generated SDK carry the enum of model ids
 * the API will accept, and the commit that adds one is the first public keystroke naming it. Read
 * on 2026-09-21, the OpenAI specification carried `gpt-6-astra` from 2026-09-03 and the Anthropic
 * SDK's `Model` union carried `claude-opus-5` from 2026-07-24, each added by a commit whose message
 * says so in as many words.
 *
 * Whether either actually beats the catalogues cannot be answered from stored data: the event log
 * begins 2026-09-08, and the one model whose first sighting is safely after it -- `gpt-live-1` --
 * reached the OpenAI catalogue ten minutes *before* the commit. So both start in shadow and
 * `lead-time` decides, which is the same bargain every unproven source here is offered.
 *
 * The releases of the Anthropic SDK are already a source; these are its commits, which are earlier
 * than the release that carries them.
 */
const MODEL_SPECS: readonly (AppConfig["github"][number] & { vendor: string })[] = [
  // The specification is one 3.6 MB file, and every model id the API accepts is in it.
  { repo: "openai/openai-openapi", vendor: "OpenAI", paths: ["openapi.yaml"] },
  // `Model` is a union of string literals in the messages resource; `api.md` is its generated index.
  { repo: "anthropics/anthropic-sdk-typescript", vendor: "Anthropic", paths: ["src/resources/messages/", "api.md"] },
];

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

  for (const spec of MODEL_SPECS) {
    definitions.push({
      id: `github:${spec.repo}:commits`,
      authority: "vendor_owned",
      vendor: spec.vendor,
      group: "GitHub",
      stream: "github",
      intervalSeconds: 1800,
      collector: () => collectGithubCommits(db, config, spec, fetch, cache),
    });
  }

  for (const [index, watch] of MODEL_MENTION_REPOS.entries()) {
    definitions.push({
      id: mentionSource(watch.repo),
      authority: watch.authority,
      ...(watch.vendor ? { vendor: watch.vendor } : {}),
      group: "GitHub",
      stream: "github",
      // One request when nothing moved; one more per commit when something did.
      intervalSeconds: 600 + index * 20,
      requiredCapabilities: ["GITHUB_TOKEN"],
      capabilityId: "github",
      collector: () => collectModelMentions(db, config, watch, fetch),
    });
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
