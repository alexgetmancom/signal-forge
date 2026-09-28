import type { AppConfig } from "../../config.js";
import { bundleMemory } from "../bundleMemory.js";
import { collectClaudeCodeModels } from "../claudeCode.js";
import { CLI_BUNDLES, collectCliBundle } from "../cliBundles.js";
import { collectCodexModels } from "../codex.js";
import { collectCommandCodeModels, collectOpenCodeGo, collectOpenCodeZen } from "../codingPlans.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectGithubDiscovery, collectHuggingFaceTrending, GITHUB_DISCOVERY_QUERIES } from "../discovery.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases } from "../github.js";
import { type KindMember, type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectPolymarket } from "../markets.js";
import { collectModelMentions, MODEL_MENTION_REPOS, mentionSource } from "../modelMentions.js";
import { collectDocsProbe, collectOpenCodeData, PROBE_SITES } from "../probes.js";
import { collectRepoTalk, talkSource } from "../repoTalk.js";
import { collectMimoTraining } from "../training.js";
import type { Vendor } from "../vendors.js";

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
const MODEL_SPECS: readonly (AppConfig["github"][number] & { vendor: Vendor })[] = [
  // The specification is one 3.6 MB file, and every model id the API accepts is in it.
  { repo: "openai/openai-openapi", vendor: "OpenAI", paths: ["openapi.yaml"] },
  // `Model` is a union of string literals in the messages resource; `api.md` is its generated index.
  { repo: "anthropics/anthropic-sdk-typescript", vendor: "Anthropic", paths: ["src/resources/messages/", "api.md"] },
];

/**
 * A repository this tracker does not own, read for what happens in it: pull requests, commits,
 * releases and what people say in the issues. The maker's own repositories are a different kind --
 * `vendor-repository` below -- because who owns the repository is the whole difference between a
 * name somebody guessed and a name somebody shipped, and a reader of `source-kinds` could not see
 * that difference while both were one unnamed family of 38.
 *
 * Half an hour is the pace: none of these is the first word on a release, and the GitHub budget is
 * shared with everything else here.
 */
const WATCHED_REPOSITORY: SourceKind = {
  kind: "watched-repository",
  authority: "third_party",
  // Work in progress in somebody else's repository: a name on an added line, an issue, a pull
  // request. It stands alone until a catalogue or the maker says the same.
  evidence: "github_activity",
  confidence: "observed",
  group: "GitHub",
  stream: "github",
  intervalSeconds: 1800,
};

/**
 * A maker's own repository, and the artifacts published from it: the model lists inside its CLI,
 * the commits to its API specification, the release bundles its client downloads. Vendor-owned, so
 * a name found here is the maker writing it down for a machine rather than somebody reading tea
 * leaves; what that is worth is `confidenceFor`'s business, not this registry's.
 */
const VENDOR_REPOSITORY: SourceKind = {
  kind: "vendor-repository",
  authority: "vendor_owned",
  // Still activity rather than availability: the maker wrote the name down for a machine, which is
  // not the maker saying the model can be called.
  evidence: "github_activity",
  confidence: "observed",
  group: "GitHub",
  stream: "github",
  intervalSeconds: 1800,
};

/** GitHub repositories and discovery: what third parties publish before any vendor says so. */
/**
 * Asking a maker's own site for a model it has not announced.
 *
 * A handful of addresses, asked often. This is the one kind that can be first: the page is written
 * before the announcement and answers to anyone who names it, so the whole value is in the minutes.
 * Five minutes is a dozen requests an hour against a host that serves millions, and nothing is
 * stored unless an address answers. `discovery:` makes every hit a radar sighting and never a
 * catalogue: a page is evidence that a name exists, not that the model is out.
 */
const DOCUMENTATION_PROBE: SourceKind = {
  kind: "documentation-probe",
  authority: "vendor_owned",
  // A page that answers to a name nobody announced. Evidence that the name exists, and deliberately
  // never a catalogue: the whole point of the probe is that the model is not out yet.
  evidence: "web_diff",
  confidence: "observed",
  group: "Discovery",
  stream: "pages",
  intervalSeconds: 300,
};

/**
 * Every repository read, sorted by who owns it. Its own declaration rather than part of
 * `communitySources`: the two kinds and the four lists that feed them are the longest thing in the
 * pack and the only part of it that is about one group.
 */
function repositorySources({ db, config, cache }: SourceContext): SourceEntry[] {
  /** Every repository read, sorted by who owns it; the id and the collector are all that differ. */
  const watched: KindMember[] = [];
  const owned: KindMember[] = [
    { id: "codex-models", vendor: "OpenAI", collector: () => collectCodexModels(fetch, cache) },
    {
      id: "claude-code-models",
      vendor: "Anthropic",
      // A release is a 103.5 MB download unpacking to 230.4 MB, read only when the version moves.
      intervalSeconds: 3600,
      heavy: true,
      collector: () => collectClaudeCodeModels(fetch, bundleMemory(db, "claude-code-models")),
    },
  ];

  for (const watch of config.github) {
    const repository = watch.repo.startsWith("deepseek-ai/") ? owned : watched;
    repository.push(
      { id: `github:${watch.repo}:pulls`, collector: () => collectGithubPulls(db, config, watch, fetch, cache) },
      { id: `github:${watch.repo}:commits`, collector: () => collectGithubCommits(db, config, watch, fetch, cache) },
      // A tagged release is the one thing read from a repository that is not work in progress: the
      // artifact exists and can be installed, whoever owns the repository.
      {
        id: `github:${watch.repo}:releases`,
        confidence: "confirmed",
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
      },
    );
  }

  for (const spec of MODEL_SPECS)
    owned.push({
      id: `github:${spec.repo}:commits`,
      vendor: spec.vendor,
      collector: () => collectGithubCommits(db, config, spec, fetch, cache),
    });

  for (const [index, watch] of MODEL_MENTION_REPOS.entries()) {
    if (!watch.talkOnly)
      (watch.authority === "vendor_owned" ? owned : watched).push({
        id: mentionSource(watch.repo),
        ...(watch.vendor ? { vendor: watch.vendor } : {}),
        // One request when nothing moved; one more per commit when something did.
        intervalSeconds: 600 + index * 20,
        requiredCapabilities: ["GITHUB_TOKEN"],
        capabilityId: "github",
        collector: () => collectModelMentions(db, config, watch, fetch),
      });
    // What is said in a repository is said by whoever turns up, so talk is watched even when the
    // repository is the maker's own.
    watched.push({
      id: talkSource(watch.repo),
      ...(watch.vendor ? { vendor: watch.vendor } : {}),
      // Two REST requests and one GraphQL query a poll, whatever was said.
      intervalSeconds: 900 + index * 20,
      requiredCapabilities: ["GITHUB_TOKEN"],
      capabilityId: "github",
      collector: () => collectRepoTalk(db, config, watch, fetch),
    });
  }

  for (const bundle of CLI_BUNDLES)
    owned.push({
      id: bundle.source,
      vendor: bundle.vendor,
      // A 20 to 30 MB download, read only when the published version moves.
      intervalSeconds: 3600,
      heavy: true,
      collector: () => collectCliBundle(bundle, fetch, bundleMemory(db, bundle.source)),
    });

  return [...sourcesOfKind(WATCHED_REPOSITORY, watched), ...sourcesOfKind(VENDOR_REPOSITORY, owned)];
}

export function communitySources({ db, config, cache }: SourceContext): SourceEntry[] {
  const definitions: SourceEntry[] = [
    {
      id: "mimo-training",
      authority: "first_party",
      // A training run's own dashboard. No catalogue, no page, no announcement: no evidence type
      // fits a model that is still being trained.
      evidence: "unknown",
      confidence: "observed",
      vendor: "Xiaomi",
      group: "Discovery",
      stream: "training",
      intervalSeconds: 1800,
      collector: () => collectMimoTraining(),
    },
    {
      id: "polymarket",
      authority: "third_party",
      // Strangers pricing a rumour. A market observes no surface at all, so there is no evidence
      // type to name, and it is pinned to the floor here so that raising any default can never
      // quietly promote a bet into evidence.
      evidence: "unknown",
      confidence: "observed",
      // Three pages and 2.2 MB of JSON after asking for liquid markets directly on 2026-09-28.
      // The source stays in a child process until its measured peak shows it fits the light lane.
      heavy: true,
      group: "Discovery",
      stream: "markets",
      // Prices move all day and the record only keeps five-point buckets, so a slower poll would
      // read the same numbers; an hour is what the other discovery sources run at.
      intervalSeconds: 3600,
      pace: { group: "polymarket.com", seconds: 60 },
      collector: () => collectPolymarket(fetch, cache),
    },
    /**
     * The coding subscriptions' model lists: small JSON answers, read every two minutes.
     *
     * This is where a stealth model appears first and free, and it is the fastest hand this tracker
     * has: Space Bunny was on Zen and Go on 2026-09-23 a quarter of an hour before OpenRouter listed
     * it. A quarter-hour poll spent most of that lead waiting. The cost is nothing a database sees --
     * a snapshot is stored only when the body changes, and Zen wrote three rows in the day to
     * 2026-09-23 -- so the only thing spent is a small request against a small file.
     */
    {
      id: "opencode-zen",
      authority: "third_party",
      // A coding subscription's model list: what it will serve, which is availability from somebody
      // who is not the maker.
      evidence: "availability_catalogue",
      confidence: "observed",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 120,
      collector: () => collectOpenCodeZen(fetch),
    },
    {
      id: "opencode-go",
      authority: "third_party",
      // A coding subscription's model list: what it will serve, which is availability from somebody
      // who is not the maker.
      evidence: "availability_catalogue",
      confidence: "observed",
      group: "Catalogues",
      stream: "api-models",
      intervalSeconds: 120,
      collector: () => collectOpenCodeGo(fetch),
    },
    {
      id: "command-code-models",
      authority: "third_party",
      // A coding subscription's model list: what it will serve, which is availability from somebody
      // who is not the maker.
      evidence: "availability_catalogue",
      confidence: "observed",
      group: "Catalogues",
      stream: "api-models",
      // A 2 MB package, downloaded only when its version moves.
      intervalSeconds: 1800,
      collector: () => collectCommandCodeModels(fetch),
    },
  ];

  for (const query of GITHUB_DISCOVERY_QUERIES) {
    definitions.push({
      id: `discovery:github-${query.id}`,
      authority: "third_party",
      // A search over repositories nobody here chose to watch.
      evidence: "github_activity",
      confidence: "observed",
      group: "Discovery",
      stream: "github",
      intervalSeconds: 3600,
      requiredCapabilities: ["GITHUB_TOKEN"],
      pace: { group: "github-search", seconds: 60 },
      collector: () => collectGithubDiscovery(config, query, fetch, new Date(), cache),
    });
  }

  definitions.push(
    ...sourcesOfKind(
      DOCUMENTATION_PROBE,
      PROBE_SITES.map((site) => ({
        id: site.id,
        vendor: site.vendor,
        // One host per probe, so a slow answer from one maker never delays a question to another.
        pace: { group: site.id, seconds: 5 },
        collector: () => collectDocsProbe(db, site, fetch),
      })),
    ),
  );
  definitions.push({
    id: "discovery:opencode-data",
    authority: "third_party",
    // OpenCode's own catalogue of other makers' models: availability, and never a maker's word.
    evidence: "availability_catalogue",
    confidence: "observed",
    group: "Discovery",
    stream: "api-models",
    intervalSeconds: 900,
    pace: { group: "opencode.ai", seconds: 5 },
    /**
     * Thirty-two lab pages of about 150 KB each, because this reads OpenCode's catalogue rather than
     * guessing at addresses in it. Measured 2026-09-27 with `source-cost`: 27 MB claimed on the
     * first pass and 9 MB more on the second, and RSS is never given back, so in the long-lived
     * service that would be a floor that keeps rising. Collected in a child, which ends.
     */
    heavy: true,
    collector: () => collectOpenCodeData(db, fetch),
  });
  definitions.push({
    id: "discovery:huggingface-trending",
    authority: "third_party",
    // The hub's trending list. The weights are real; being liked is not a release, and the list is
    // somebody else's ordering of it, so this stays at the floor where the accounts are supported.
    evidence: "open_weights",
    confidence: "observed",
    group: "Discovery",
    stream: "weights",
    // The list moves with likes over days, so an hour is early enough to see a model enter it.
    intervalSeconds: 3600,
    pace: { group: "huggingface.co", seconds: 10 },
    collector: () => collectHuggingFaceTrending(config, fetch, cache, new Date()),
  });

  definitions.push(...repositorySources({ db, config, cache }));
  return definitions;
}
