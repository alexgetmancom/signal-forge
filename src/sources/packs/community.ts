import type { AppConfig } from "../../config.js";
import { bundleMemory } from "../bundleMemory.js";
import { claudeCodeUnchanged, collectClaudeCodeModels } from "../claudeCode.js";
import { CLI_BUNDLES, cliBundleUnchanged, collectCliBundle } from "../cliBundles.js";
import { collectCodexModels } from "../codex.js";
import { collectCommandCodeModels, collectOpenCodeGo, collectOpenCodeZen } from "../codingPlans.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectGithubDiscovery, collectHuggingFaceTrending, GITHUB_DISCOVERY_QUERIES } from "../discovery.js";
import { collectGithubCommits, collectGithubPulls, collectGithubReleases, githubCommitsUnchanged } from "../github.js";
import { acceptedEtagUnchanged } from "../http.js";
import { type KindMember, type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectPolymarket } from "../markets.js";
import { collectModelMentions, MODEL_MENTION_REPOS, mentionSource } from "../modelMentions.js";
import { collectOpenCodeData, OPENCODE_MODELS_URL } from "../opencodeData.js";
import { collectDocsProbe, PROBE_SITES } from "../probes.js";
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
/**
 * A model id compiled into a client the maker publishes.
 *
 * Not a repository, though these sat in `VENDOR_REPOSITORY` for want of anywhere better and were
 * described to readers in words written for a commit. Nothing here reads a commit: it downloads the
 * published tarball and scans the built binary, so the name has been shipped to every user of the
 * client. That is stronger than a keystroke in a repository and weaker than a catalogue, which is
 * the maker saying the model can be called -- its own evidence type, `binary_string`, and its own
 * sentence on the card.
 *
 * Five minutes, against the hour these ran at while the download and the version check were one
 * source. Only the dist-tags document is read at that pace; see `nothingNew` in
 * src/sources/definition.ts for the split that makes the pace affordable.
 */
const SHIPPED_BINARY: SourceKind = {
  kind: "shipped-binary",
  authority: "vendor_owned",
  evidence: "binary_string",
  confidence: "observed",
  group: "Shipped binaries",
  stream: "github",
  intervalSeconds: 300,
  pace: { group: "registry.npmjs.org", seconds: 5 },
};

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
  appendOnly: true,
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
 * A search over repositories nobody here chose to watch.
 *
 * It finds a repository by what it is about rather than by who owns it, and every member is
 * append-only because none of them reads a state anyone maintains. They share one pacing group, so
 * the four searches are one request a minute between them.
 */
const REPOSITORY_SEARCH: SourceKind = {
  kind: "repository-search",
  appendOnly: true,
  authority: "third_party",
  evidence: "github_activity",
  confidence: "observed",
  group: "Discovery",
  stream: "github",
  intervalSeconds: 3600,
  pace: { group: "github-search", seconds: 60 },
};

/**
 * The coding subscriptions' model lists: small JSON answers, read every two minutes.
 *
 * This is where a stealth model appears first and free, and it is the fastest hand this tracker
 * has: Space Bunny was on Zen and Go on 2026-09-23 a quarter of an hour before OpenRouter listed
 * it. A quarter-hour poll spent most of that lead waiting. The cost is nothing a database sees --
 * a snapshot is stored only when the body changes, and Zen wrote three rows in the day to
 * 2026-09-23 -- so the only thing spent is a small request against a small file.
 *
 * What a subscription will serve is availability from somebody who is not the maker.
 */
const CODING_PLAN_LIST: SourceKind = {
  kind: "coding-plan-list",
  authority: "third_party",
  evidence: "availability_catalogue",
  confidence: "observed",
  group: "Catalogues",
  stream: "api-models",
  intervalSeconds: 120,
};

/**
 * Sources that look for a name nobody has published: a search, a probe, a trending list.
 *
 * Its own declaration rather than the tail of `communitySources`, on the same grounds as
 * `repositorySources` above: this is the half of the pack that asks a question nobody answered
 * yet, while the other half reads something a third party chose to publish. Every member is
 * append-only, because none of them reads a state anyone maintains.
 */
function discoverySources({ db, config, cache }: SourceContext): SourceEntry[] {
  const definitions: SourceEntry[] = [];
  definitions.push(
    ...sourcesOfKind(
      REPOSITORY_SEARCH,
      GITHUB_DISCOVERY_QUERIES.map((query) => ({
        id: `discovery:github-${query.id}`,
        requiredCapabilities: ["GITHUB_TOKEN"],
        collector: () => collectGithubDiscovery(config, query, fetch, new Date()),
      })),
    ),
  );

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
    appendOnly: true,
    authority: "third_party",
    // The canonical registry behind OpenCode's pages: availability, never a maker's word.
    evidence: "availability_catalogue",
    confidence: "observed",
    group: "Discovery",
    stream: "api-models",
    intervalSeconds: 900,
    pace: { group: "models.opencode.ai", seconds: 5 },
    nothingNew: () => acceptedEtagUnchanged(db, cache, "discovery:opencode-data", OPENCODE_MODELS_URL),
    collector: () => collectOpenCodeData(fetch, cache),
  });
  definitions.push({
    id: "discovery:huggingface-trending",
    appendOnly: true,
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

  return definitions;
}

/**
 * Every repository read, sorted by who owns it. Its own declaration rather than part of
 * `communitySources`: the two kinds and the four lists that feed them are the longest thing in the
 * pack and the only part of it that is about one group.
 */
function repositorySources({ db, config, cache }: SourceContext): SourceEntry[] {
  /** Every repository read, sorted by who owns it; the id and the collector are all that differ. */
  const watched: KindMember[] = [];
  const owned: KindMember[] = [
    {
      id: "codex-models",
      vendor: "OpenAI",
      // The rest of this kind reads the GitHub API under a token's budget. This one reads a single
      // raw file, and 99.1% of its asks came back 304 over the week of 2026-09-30 -- 107 requests,
      // one body, 211 KB a day -- so the kind's half hour buys nothing here and costs a release.
      // OpenAI writes a model into this file before anyone announces it and we see the commit in
      // minutes: gpt-6-sol and gpt-6-luna were committed at 18:17:39 on 2026-09-22 and detected at
      // 18:20:38, while gpt-6.1-sol took 19 of the 30 a half hour can hide.
      intervalSeconds: 300,
      collector: () => collectCodexModels(fetch, cache),
    },
  ];

  for (const watch of config.github) {
    const repository = watch.repo.startsWith("deepseek-ai/") ? owned : watched;
    repository.push(
      {
        id: `github:${watch.repo}:pulls`,
        appendOnly: true,
        requiredCapabilities: ["GITHUB_TOKEN"],
        capabilityId: "github",
        collector: () => collectGithubPulls(db, config, watch, fetch),
      },
      {
        id: `github:${watch.repo}:commits`,
        appendOnly: true,
        nothingNew: () => githubCommitsUnchanged(db, config, watch.repo, fetch, cache),
        collector: () => collectGithubCommits(db, config, watch, fetch, cache),
      },
      // A tagged release is the one thing read from a repository that is not work in progress: the
      // artifact exists and can be installed, whoever owns the repository.
      {
        id: `github:${watch.repo}:releases`,
        appendOnly: true,
        confidence: "confirmed",
        collector: () => collectGithubReleases(db, config, watch, fetch, cache),
      },
    );
  }

  for (const spec of MODEL_SPECS)
    owned.push({
      id: `github:${spec.repo}:commits`,
      appendOnly: true,
      vendor: spec.vendor,
      nothingNew: () => githubCommitsUnchanged(db, config, spec.repo, fetch, cache),
      collector: () => collectGithubCommits(db, config, spec, fetch, cache),
    });

  for (const [index, watch] of MODEL_MENTION_REPOS.entries()) {
    if (!watch.talkOnly)
      (watch.authority === "vendor_owned" ? owned : watched).push({
        id: mentionSource(watch.repo),
        appendOnly: true,
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
      appendOnly: true,
      ...(watch.vendor ? { vendor: watch.vendor } : {}),
      // Two REST requests and one GraphQL query a poll, whatever was said.
      intervalSeconds: 900 + index * 20,
      requiredCapabilities: ["GITHUB_TOKEN"],
      capabilityId: "github",
      collector: () => collectRepoTalk(db, config, watch, fetch),
    });
  }

  return [
    ...sourcesOfKind(WATCHED_REPOSITORY, watched),
    ...sourcesOfKind(VENDOR_REPOSITORY, owned),
    ...shippedBinarySources(db),
  ];
}

/** Installed clients share neither the repository requests nor their credential. */
function shippedBinarySources(db: SourceContext["db"]): SourceEntry[] {
  const binaries: KindMember[] = [
    {
      id: "claude-code-models",
      vendor: "Anthropic",
      // A release is a 103.5 MB download unpacking to 230.4 MB, read only when the version moves.
      heavy: true,
      nothingNew: () => claudeCodeUnchanged(fetch, bundleMemory(db, "claude-code-models")),
      collector: () => collectClaudeCodeModels(fetch, bundleMemory(db, "claude-code-models")),
    },
  ];
  for (const bundle of CLI_BUNDLES)
    binaries.push({
      id: bundle.source,
      vendor: bundle.vendor,
      // A 20 to 30 MB download, read only when the published version moves.
      heavy: true,
      nothingNew: () => cliBundleUnchanged(bundle, fetch, bundleMemory(db, bundle.source)),
      collector: () => collectCliBundle(bundle, fetch, bundleMemory(db, bundle.source)),
    });

  return sourcesOfKind(SHIPPED_BINARY, binaries);
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
      // The AI-release tag reduced the response to 212 KB. Measured 2026-10-04: the
      // collector claims 24 MB on its first read, below the 32 MB child-process threshold.
      group: "Discovery",
      stream: "markets",
      // Prices move all day and the record only keeps five-point buckets, so a slower poll would
      // read the same numbers; an hour is what the other discovery sources run at.
      intervalSeconds: 3600,
      pace: { group: "polymarket.com", seconds: 60 },
      collector: () => collectPolymarket(fetch, cache),
    },
    ...sourcesOfKind(CODING_PLAN_LIST, [
      { id: "opencode-zen", collector: () => collectOpenCodeZen(fetch) },
      { id: "opencode-go", collector: () => collectOpenCodeGo(fetch) },
      {
        id: "command-code-models",
        // A 2 MB package, downloaded only when its version moves.
        intervalSeconds: 1800,
        collector: () => collectCommandCodeModels(fetch),
      },
    ]),
  ];

  definitions.push(...discoverySources({ db, config, cache }));
  definitions.push(...repositorySources({ db, config, cache }));
  return definitions;
}
