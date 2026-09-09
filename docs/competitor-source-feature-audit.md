# Competitor and Source Audit

Status: baseline audit completed 2026-09-09 UTC. The selected implementation is now in the working tree; source-gap tables below describe the pre-implementation state.

Date: 2026-09-09 UTC

## Purpose

This document consolidates the seven repository audits requested for Signal Forge. Each audit had two passes:

1. a feature and architecture audit;
2. a source-inventory audit covering actual endpoints, models, vendors, fields, cadence, coverage gaps, and weak inputs.

The goal is not to reproduce any of the projects. The goal is to identify source families and behaviors that can improve Signal Forge while preserving its stronger properties:

- Bun + TypeScript + SQLite;
- one source registry and one runtime supervisor;
- Zod validation at external boundaries;
- immutable before/after evidence;
- snapshots, events, stories, and delivery preparation in one SQLite transaction;
- confidence and evidence semantics that do not overstate weak sources;
- fail-closed collection behavior;
- ambiguous external delivery outcomes that are never blindly retried;
- LAN-only operation and outbound-only publication;
- no paid social APIs or private inbox integrations;
- no compatibility shims, duplicate persistence systems, speculative framework layers, or public deployment paths.

## Executive conclusion

There is no exact competitor that combines Signal Forge's breadth, immutable event model, source semantics, story projection, delivery verification, and operational discipline.

The strongest practical additions are:

1. an official DeepSeek source pack;
2. expanded provider deprecation coverage;
3. official Google, Codex, Claude Code, Microsoft, NVIDIA, and Hugging Face feeds;
4. source authority and independent-support metadata;
5. suspicious collection-shrinkage detection;
6. deterministic cross-source story merging;
7. source contribution and freshness metrics;
8. one carefully chosen independent benchmark lane;
9. Arena quality improvements rather than a second Arena collector;
10. richer Hugging Face metadata, with volatile counters kept out of the notification path.

The following should not be added to the main service:

- Reddit scraping;
- X/Twitter integrations;
- SocialData, TikHub, or similar paid scraping services;
- private AgentMail or inbox ingestion;
- generic media firehoses;
- public GitHub Pages publication;
- Git-committed JSON as a second source of truth;
- Jina plus LLM table extraction when a direct parser is possible;
- a second JSONL event ledger;
- multi-persona editorial scoring as a substitute for evidence;
- large source frameworks built before there is a second real implementation that needs them.

The recommended implementation order is:

```text
hardening
  -> evidence-aware stories and notification quality
  -> official DeepSeek and lifecycle sources
  -> official product and vendor feeds
  -> one benchmark lane and Arena improvements
  -> source contribution metrics and optional low-confidence discovery
```

## 1. Signal Forge baseline

Signal Forge is an observability service for changes in AI models, developer tools, documentation, packages, arenas, incidents, and platform catalogues. Its current scope and architecture are documented in [README.md](../README.md).

### Current source families

The current registry in [src/sources/registry.ts](../src/sources/registry.ts) includes:

- first-party model catalogues;
- OpenRouter availability and pricing;
- Arena roster and leaderboards;
- selected Hugging Face and ModelScope organizations;
- Codex and Claude web/documentation surfaces;
- Cursor changelog;
- OpenAI and Anthropic news;
- OpenAI and Anthropic deprecations;
- OpenAI and Anthropic status pages;
- configured GitHub commits, pull requests, and releases;
- configured npm and PyPI packages;
- selected open-weight registries;
- DesignArena and other community surfaces.

### Current safety properties

The current event path in [src/events/store.ts](../src/events/store.ts) already provides several protections that the audited projects do not consistently provide:

- empty collections are rejected;
- duplicate normalized record IDs are rejected;
- malformed external responses fail before persistence;
- before/after event evidence is immutable;
- source records and events are updated transactionally;
- append-only sources do not generate false removals;
- story projection is derived without rewriting event evidence;
- failed delivery is distinguished from ambiguous delivery;
- delivery ambiguity is manually reconciled rather than blindly retried.

The project already has source health in [src/status.ts](../src/status.ts), actionable issues in [src/issues.ts](../src/issues.ts), and signal-quality reporting in [src/signalQuality.ts](../src/signalQuality.ts).

That means most useful work is not a rewrite. It is the addition of missing source coverage and a few derived quality fields around the existing transaction boundary.

## 2. Audit: EthanHarwood97/ai-model-tracker

Repository: [EthanHarwood97/ai-model-tracker](https://github.com/EthanHarwood97/ai-model-tracker)

Relevant code: [source modules](https://github.com/EthanHarwood97/ai-model-tracker/tree/main/model_tracker/sources), [validation.py](https://github.com/EthanHarwood97/ai-model-tracker/blob/main/model_tracker/validation.py), [scheduler.py](https://github.com/EthanHarwood97/ai-model-tracker/blob/main/model_tracker/scheduler.py), [composite.py](https://github.com/EthanHarwood97/ai-model-tracker/blob/main/model_tracker/composite.py), [pipeline tests](https://github.com/EthanHarwood97/ai-model-tracker/tree/main/tests)

### Verified repository shape

This is a self-hosted multi-source model evidence and score tracker. It uses SQLite snapshots, a source-level change log, evidence lanes, benchmark aggregation, role-specific recommendations, source validation, caching, backoff, and scheduled publication through GitHub Actions.

The scheduled workflow runs roughly every 30 minutes, rebuilds history from source snapshots, detects new/updated/removed rows, and publishes a static dashboard. The repository has 536 commits but currently has no meaningful public adoption signal such as stars or forks. That is not a quality judgment; it is simply a small, actively developed project.

### Actual sources

| Source | Signals | Signal Forge status |
|---|---|---|
| Artificial Analysis coding agents | harness, model, effort, fallback, index, cost, wall time | Missing |
| Artificial Analysis model leaderboard | model, intelligence, coding index, price, release date, deprecation, context, speed, latency, vision | Missing |
| Artificial Analysis changelog | article title, date, slug | Missing |
| OpenRouter | model ID, pricing, context, creation time, modalities, architecture, parameters | Covered |
| DeepSeek official pricing | peak/off-peak cache-hit, cache-miss, output pricing, peak hours | Missing |
| Arena/LMSYS | model, organization, rank, rating, votes, confidence interval | Partially covered |
| LiveBench | global, coding, agentic, reasoning scores, cost per successful task | Missing |
| SWE-bench | model, organization, agent, release date, resolved instances, score, average cost | Missing |
| Aider Polyglot | model, pass percentage, cost per run | Missing |
| EvalPlus | HumanEval+, MBPP+, baseline scores, parameter size, open-data flag | Missing |
| Hugging Face Open LLM Leaderboard | model, architecture, parameter size, precision, type, average score | Partially covered; repository feeds are not benchmark feeds |
| Terminal-Bench | agent, model, accuracy | Missing |
| DeepSWE | model, effort, pass@1, pass@4, task-pass rate, cost, confidence interval, task count | Missing |
| BFCL/Gorilla | model and selected overall score | Missing |

The repository does not use GitHub, npm, PyPI, vendor status pages, general vendor news, ModelScope, or general Hugging Face author feeds as collectors. Those are already covered more directly by Signal Forge's existing source families.

### Useful features to take

#### Normalized-record validation

The repository validates normalized rows after source-specific parsing. A row without a usable name, kind, score, or required field cannot reach the score pipeline.

Signal Forge already validates upstream payloads with Zod and rejects empty or duplicate collections. The remaining gap is a final common contract before persistence:

- `id` must be a non-empty string;
- `name` must be a non-empty string;
- IDs must be unique;
- source-specific fields stay source-specific;
- invalid normalized output must leave the transaction untouched.

Recommendation: adapt. This is small and directly prevents silent wiring errors.

Likely files:

- [src/events/store.ts](../src/events/store.ts)
- [tests/events.test.ts](../tests/events.test.ts)

#### Evidence coverage

The tracker separates measured benchmark evidence, supporting evidence, predictions, and coverage. It refuses to treat missing evidence as a synthetic score.

Signal Forge has confidence, evidence types, source names, event IDs, aliases, and stories, but a story does not explicitly show how broadly supported it is.

Useful derived fields:

```ts
evidenceCoverage: {
  eventCount: number;
  sourceCount: number;
  sourceFamilies: string[];
  evidenceTypes: EvidenceType[];
  corroborated: boolean;
}
```

This must be derived, not stored as a subjective score. It must not rewrite event confidence.

#### Fixture-driven replay tests

The tracker runs deterministic tests before publication. Signal Forge already has strong parser tests, but a small replay corpus would cover the complete path more reliably:

1. source payload;
2. normalized collection;
3. first observation;
4. identical second observation;
5. one meaningful change;
6. malformed response;
7. empty or truncated response;
8. event and delivery transaction behavior.

Recommended fixtures:

- OpenRouter;
- Arena;
- DeepSeek changelog;
- one deprecation provider;
- one GitHub release;
- one official RSS feed.

#### Operator visibility of next attempt

The project shows source backoff and pauses after repeated failures. Signal Forge already has better rate-limit handling, pacing, retry timestamps, and health states. The only useful addition would be a derived `nextAttemptAt` for generic source failures.

### Do not take

- benchmark-specific recommendation scores;
- role-specific model recommendations;
- separate score tables that duplicate Signal Forge events;
- direct webhook delivery that hides uncertain outcomes;
- separate snapshot/change commits;
- GitHub Pages publication;
- their disk-cache and retry implementation;
- score-only diffing, because Signal Forge tracks pricing, capabilities, lifecycle, and metadata too.

### Source additions recommended from this repository

1. DeepSeek official pricing, but with dynamic model discovery.
2. Artificial Analysis changelog.
3. Artificial Analysis model and coding-agent leaderboards.
4. Arena frontend/WebDev leaderboard.
5. One independent benchmark lane, preferably Aider or LiveBench.
6. Hugging Face Open LLM benchmark data, separately from model repository feeds.

Do not implement all benchmark sources in one batch. Each parser is a new maintenance burden.

## 3. Audit: awesome-deepseekharness/deepseek-official-tracker

Repository: [awesome-deepseekharness/deepseek-official-tracker](https://github.com/awesome-deepseekharness/deepseek-official-tracker)

Relevant code: [track.mjs](https://github.com/awesome-deepseekharness/deepseek-official-tracker/blob/main/scripts/track.mjs), [track.yml](https://github.com/awesome-deepseekharness/deepseek-official-tracker/blob/main/.github/workflows/track.yml), [discover.mjs](https://github.com/awesome-deepseekharness/deepseek-official-tracker/blob/main/scripts/discover.mjs), [state.json](https://github.com/awesome-deepseekharness/deepseek-official-tracker/blob/main/data/state.json)

### Verified deterministic sources

| Source | Extracted data | Frequency and limitation |
|---|---|---|
| DeepSeek API changelog | date, title, summary, models, pricing, deprecations, API features | Every six hours; retains the last 600 keys |
| DeepSeek API news | title, published date, URL | Every six hours; only news linked from the changelog, up to 12 pages |
| DeepSeek website news | slug, title, date, description | Every six hours; up to 10 pages |
| Official GitHub releases and tags | tag, release title, published timestamp, URL | Five releases/tags per repository; 24 repositories in code |
| `@deepseek-ai/dsh` npm | latest tag, versions, publication times | Every six hours; each version becomes an entry |
| Hugging Face `deepseek-ai` | model ID, modification date, likes, downloads, tags, pipeline type | Newest 20 models only; metadata changes are not events |

The optional AI-discovery workflow also consults OpenCode Zen, arXiv, GitHub search, Hugging Face search, npm search, X, Reddit, Hacker News, media, WeChat, and Discord through free-form research. Those are not durable structured source records and should not be imported into Signal Forge's confirmed evidence path.

### DeepSeek entities observed

The feed includes V4 Pro, V4 Flash, V4 Vision, V4 Base/DSpark variants, V3.2, V3.2-Speciale, V3.2-Exp, V3.1, V3.1-Terminus, V3, R1, and Hugging Face derivative families.

The repository list covers:

- DeepSeek-V3;
- DeepSeek-R1;
- DeepSeek-OCR and OCR-2;
- DeepSeek-VL2;
- DeepSeek-Coder-V2;
- DeepSeek-Math-V2;
- DeepSeek-Prover-V2;
- DeepSeek-V3.2-Exp;
- Janus;
- FlashMLA;
- DeepEP;
- DeepGEMM;
- 3FS;
- smallpond;
- DeepSpec;
- TileKernels;
- Engram;
- DualPipe;
- EPLB;
- ESFT;
- LPLB;
- deepseek-harness;
- awesome-deepseek-integration.

### Useful features to take

- official-only source pack with multiple lead times;
- exact source URL preservation;
- separate API, website, GitHub, npm, and Hugging Face channels;
- cross-source story support;
- model/package/repository lifecycle correlation.

### Do not take

- Markdown files as the source of truth;
- corrupt state falling back to an empty state;
- continuing after a failed official source and presenting the result as a quiet run;
- fixed page limits without an explicit completeness result;
- free-form AI research becoming durable confirmed events;
- AI-generated PR automation or auto-merge.

### Recommendation

This is the most straightforward concrete source pack to add to Signal Forge.

## 4. Audit: sefaertunc/anthropic-watch

Repository: [sefaertunc/anthropic-watch](https://github.com/sefaertunc/anthropic-watch)

Relevant files: [src/sources.js](https://github.com/sefaertunc/anthropic-watch/blob/main/src/sources.js), [state.js](https://github.com/sefaertunc/anthropic-watch/blob/main/src/state.js), [feed health](https://github.com/sefaertunc/anthropic-watch/tree/main/src/feed), [feed schema](https://github.com/sefaertunc/anthropic-watch/blob/main/docs/FEED-SCHEMA.md), [workflow](https://github.com/sefaertunc/anthropic-watch/blob/main/.github/workflows/scrape.yml)

### Verified source inventory

The README says 37 sources, while the current source registry contains 39 entries. That discrepancy is itself a useful warning: source counts in documentation must not be trusted over code.

#### Core sources

- Anthropic Engineering Blog;
- Anthropic News Blog;
- Anthropic model documentation table;
- Claude Code `CHANGELOG.md`;
- Anthropic support release notes;
- Claude Code GitHub releases;
- `@anthropic-ai/claude-code` npm;
- TypeScript Agent SDK changelog;
- Python Agent SDK changelog;
- TypeScript SDK releases;
- Python SDK releases.

#### Extended sources

- Claude Code Action releases;
- Anthropic alignment blog;
- Anthropic red-team blog;
- Anthropic research blog;
- Claude product blog;
- Anthropic status page.

#### Community and external sources

- commits in `anthropics/claude-cookbooks`;
- commits in `anthropics/skills`;
- commits in `anthropics/claude-plugins-official`;
- commits in `anthropics/claude-code`;
- community Claude Code repositories;
- r/ClaudeCode;
- r/ClaudeAI;
- r/claude;
- r/claudeskills;
- r/Claudeopus;
- Hacker News searches for Anthropic, Claude, and Claude.com;
- official and employee X accounts.

### Useful features to take

#### Collection continuity checks

The project detects a successful fetch that silently loses most of its retained items. Signal Forge should add a similar check for non-append-only full catalogues.

Suggested behavior:

- calculate previous count and retained count;
- classify a suspicious drop as degraded or rejected;
- preserve the last known-good records;
- do not generate removals;
- surface an operator issue;
- exempt append-only sources and sources with an explicit pagination policy.

#### Source authority

The source tiers suggest a first-class metadata field, but the names should be Signal Forge's own:

```ts
authority: "first_party" | "vendor_owned" | "third_party"
```

This stays separate from confidence and evidence type.

#### Stable external contracts

The project versions its feed schema and uses composite keys. Signal Forge already has stronger internal composite identity through `(source, id)`, event IDs, and delivery uniqueness. Only add `schemaVersion` to public HTTP/MCP outputs if a second consumer actually needs a stable contract.

### Highest-value Anthropic additions

1. `anthropics/claude-code` commits, releases, and changelog;
2. Anthropic TypeScript and Python SDK release details;
3. Claude Code Action releases;
4. Anthropic model documentation table;
5. Anthropic support release notes;
6. `anthropics/skills` and `anthropics/claude-plugins-official` commits;
7. only later, r/ClaudeCode and one Hacker News query as low-confidence corroboration.

### Do not take

- JSON known-ID state instead of SQLite;
- GitHub-committed state;
- public RSS/OPML publication;
- the permissive empty-array success behavior;
- their generic RSS GUID design;
- all community feeds by default;
- paid X/Twitter accounts.

## 5. Audit: bakulbadwal/ai-frontier-dispatch

Repository: [bakulbadwal/ai-frontier-dispatch](https://github.com/bakulbadwal/ai-frontier-dispatch)

Relevant files: [README](https://github.com/bakulbadwal/ai-frontier-dispatch/blob/master/README.md), [method](https://github.com/bakulbadwal/ai-frontier-dispatch/blob/master/references/method.md), [claim schema](https://github.com/bakulbadwal/ai-frontier-dispatch/blob/master/schemas/claim-evidence.schema.json), [source health schema](https://github.com/bakulbadwal/ai-frontier-dispatch/blob/master/schemas/source-health.schema.json), [state CLI](https://github.com/bakulbadwal/ai-frontier-dispatch/blob/master/scripts/state.py)

### Important distinction

This repository is primarily a portable Claude Code/Codex research skill. It has no source registry, no collector implementations, and no scheduled workflow. Its sources are runtime research instructions rather than durable collectors.

### Source families described

- router newest/trending listings;
- token-share and usage leaderboards;
- coding-harness usage statistics;
- independent benchmarks;
- human-preference arenas;
- Hugging Face model releases and trending;
- GitHub Trending and repository activity;
- official lab announcements and model cards;
- Hacker News;
- optional X/Grok research;
- secondary AI press;
- people and organization watchlists.

The sample configuration mentions model and organization signals including Kimi, GLM, Anthropic, NVIDIA, Microsoft MAI, Gemini, OpenAI, Meta/Llama, Qwen, Z.ai, Thinking Machines, Poolside, Anysphere, Together AI, and several developer communities. These are examples from a personalized briefing, not a verified reusable vendor registry.

### Useful features to take

#### Distribution-layer evidence

Usage, router placement, and trending status can reveal a model before an announcement. Signal Forge should treat these as discovery evidence:

- `observed` confidence;
- unresolved codename allowed;
- no automatic confirmation;
- later source can resolve identity;
- retain rank, share, timestamp, and apparent provenance.

#### Claim classification separate from confidence

The project distinguishes facts, theses, and deal status from verified, corroborated, single-source, and unverified confidence. Signal Forge does not need its market/deal vocabulary, but the separation is useful:

- evidence type describes what was observed;
- confidence describes source strength;
- interpretation describes what the system thinks the event means.

Do not collapse these dimensions into one numeric score.

#### Independent corroboration

Multiple independent source families should increase story priority, but only when they are truly independent. Two URLs from one vendor are not independent corroboration.

### Recommended additions

1. router newest/trending/token-share collector, only after a stable public endpoint is verified;
2. Hugging Face metadata and model-card changes;
3. one independent coding or agent benchmark;
4. GitHub discovery/trending, only if request volume can remain bounded;
5. official vendor feeds beyond OpenAI and Anthropic;
6. later, low-confidence Hacker News.

### Do not take

- optional Grok/X pass;
- market, deal, and career sections;
- a second JSONL ledger beside SQLite;
- personal reader profiles;
- generic adapters;
- no-source research claims becoming events.

## 6. Audit: LearnPrompt/ai-news-radar

Repository: [LearnPrompt/ai-news-radar](https://github.com/LearnPrompt/ai-news-radar)

Relevant files: [update_news.py](https://github.com/LearnPrompt/ai-news-radar/blob/master/scripts/update_news.py), [source overlap](https://github.com/LearnPrompt/ai-news-radar/blob/master/scripts/evaluate_source_overlap.py), [source quality](https://github.com/LearnPrompt/ai-news-radar/blob/master/scripts/audit_source_quality.py), [workflow](https://github.com/LearnPrompt/ai-news-radar/blob/master/.github/workflows/update-news.yml), [OPML example](https://github.com/LearnPrompt/ai-news-radar/blob/master/feeds/follow.example.opml)

### Actual official and first-party sources

- OpenAI News RSS;
- Anthropic News;
- Google DeepMind RSS;
- Google AI Blog RSS;
- Hugging Face Blog RSS;
- GitHub AI & ML RSS;
- GitHub Changelog RSS;
- OpenAI Skills Atom feed;
- OpenAI Codex changelog;
- Claude Code releases;
- OpenAI status;
- configurable OPML sources.

### Curated, community, and aggregator sources

- The Decoder;
- TechCrunch AI;
- The Verge;
- MarkTechPost Research;
- VentureBeat AI;
- Artificial Intelligence News;
- Follow Builders;
- TechURLs;
- Buzzing;
- Info Flow/Iris;
- BestBlogs;
- Hacker News Algolia;
- AI HubToday;
- AIbase;
- AI HOT;
- NewsNow;
- WaytoAGI.

Optional paid or private inputs include X API, SocialData, TikHub, and AgentMail. These are excluded from Signal Forge.

### Useful features to take

#### Deterministic cross-source story merging

The project uses:

1. tracking-parameter removal from URLs;
2. title similarity;
3. token overlap;
4. a short time window;
5. vendor/model conflict guards;
6. explicit merge reasons;
7. a primary source plus secondary references.

This is the strongest feature in the repository. It should extend the existing story projection rather than delete events or create a second deduplication store.

#### Source-overlap intake analysis

The project evaluates a candidate source against existing archives:

- hard duplicates;
- possible duplicates;
- unique contribution;
- top overlapping sources;
- accept/watch/skip recommendation.

The thresholds are advisory, not automatic source mutation. Signal Forge should eventually add a read-only operator operation for candidate-feed analysis.

#### Source contribution metrics

Useful metrics include:

- collection duration;
- valid-empty versus failed;
- source item count;
- unique stories contributed;
- secondary coverage;
- duplicate ratio;
- source AI relevance or signal contribution;
- skipped and replaced feeds.

Signal Forge should add only the metrics that have operational use. They belong in `signalQuality`, not in a separate generated JSON publication system.

#### Story-aware digest selection

The project groups duplicate coverage into one story while retaining individual source links. Signal Forge should render one digest story with several evidence links while retaining every underlying event and delivery association.

### Do not take

- generic news-reader UI;
- GitHub Actions as the runtime model;
- OPML/private-mail expansion as a default source path;
- paid social integrations;
- multi-persona scoring as confidence;
- media aggregation before primary sources are covered;
- generated JSON replacing SQLite.

## 7. Audit: oolong-tea-2026/arena-ai-leaderboards

Repository: [oolong-tea-2026/arena-ai-leaderboards](https://github.com/oolong-tea-2026/arena-ai-leaderboards)

Relevant files: [README](https://github.com/oolong-tea-2026/arena-ai-leaderboards#readme), [fetcher](https://github.com/oolong-tea-2026/arena-ai-leaderboards/blob/main/scripts/fetch_leaderboards.py), [workflow](https://github.com/oolong-tea-2026/arena-ai-leaderboards/blob/main/.github/workflows/fetch.yml), [schemas](https://github.com/oolong-tea-2026/arena-ai-leaderboards/tree/main/schemas), [current data](https://github.com/oolong-tea-2026/arena-ai-leaderboards/tree/main/data/2026-09-08)

### Actual source coverage

This repository has one evidence source: Arena AI. It does not use GitHub, npm, PyPI, Hugging Face, vendor registries, changelogs, status pages, or community feeds.

The current snapshot has board families for:

- agent;
- code;
- document;
- image-edit;
- image-to-video;
- search;
- text;
- text-to-image;
- text-to-video;
- video-edit;
- vision.

General fields:

- rank;
- model;
- vendor;
- license;
- score;
- confidence interval;
- votes.

Agent boards additionally have dynamic dimensions and sessions.

### Useful features to take

#### Vote-only suppression

Signal Forge already stores votes, but a vote-count-only change currently can create a change event. Remove votes from leaderboard comparison while retaining them in raw snapshots and meaningful before/after evidence.

#### Dynamic agent metrics

The agent board contains dimensions such as steerability, recovery, and tool hallucination. Store them as a keyed object so column order cannot create false changes.

#### Confidence-interval notification filtering

Keep score changes as evidence, but suppress score-only notifications when before/after intervals overlap. Continue notifying on meaningful rank or board-membership changes.

#### Per-board completeness and freshness

Require every board to have non-empty entries and unique board identity. Preserve:

```text
fetched_at
upstream_last_updated
model_count
board_url
```

Fetch success is not the same as upstream freshness.

#### Vendor mapping

Current Arena data includes organizations not covered by Signal Forge's vendor map, including Tencent, Runway, KlingAI, Black Forest Labs, ByteDance, NVIDIA, Recraft, and others. `SpaceXAI` also needs careful handling to avoid an overly broad `xai` match.

### Do not take

- Jina Reader;
- LLM table extraction;
- public external API;
- full-rank event tracking;
- unknown license values normalized to `open`;
- a second Arena collector;
- full daily file archives before historical analytics is a real requirement.

## 8. Audit: deprecations/deprecations-rss

Repository: [deprecations/deprecations-rss](https://github.com/deprecations/deprecations-rss)

Relevant files: [provider registry](https://github.com/deprecations/deprecations-rss/blob/main/src/providers.py), [base scraper](https://github.com/deprecations/deprecations-rss/blob/main/src/base_scraper.py), [model](https://github.com/deprecations/deprecations-rss/blob/main/src/models.py), [main](https://github.com/deprecations/deprecations-rss/blob/main/src/main.py), [workflow](https://github.com/deprecations/deprecations-rss/blob/main/.github/workflows/scrape.yml)

### Actual provider sources

| Provider | Public source | Important fields |
|---|---|---|
| OpenAI | developers.openai.com deprecations | model IDs, notice date, shutdown date, replacement, context, anchors |
| Anthropic | platform.claude.com model deprecations | model ID, status, deprecated date, retirement date, replacement, historical context |
| Google Gemini | Gemini deprecations and changelog | model ID, release date, shutdown date, replacement, notice date |
| Google Vertex | partner model deprecations | partner model, deprecated-as-of, shutdown date, context |
| AWS Bedrock | model lifecycle documentation | model/version, legacy date, EOL date, replacement, regional schedules |
| Cohere | deprecations documentation | model ID, notice date, shutdown date, replacement, context |
| Groq | deprecations documentation | model ID, announcement date, shutdown date, replacement |
| xAI | models documentation | model ID, deprecated/obsolete indicator, shutdown date, replacement |
| Azure AI Foundry | model lifecycle retirement documentation | model ID, legacy/retirement dates, replacement, anchor |

The upstream output model includes provider, model ID, announcement date, shutdown date, deprecation date, replacement models, context, URL, content hash, scraped time, first observed, and last observed.

### Useful features to take

- per-model rather than per-page-section records;
- explicit lifecycle stage;
- normalized provider dates separate from detection time;
- replacement model IDs;
- section anchors;
- provider context preserved as evidence;
- regional lifecycle schedules;
- first-observed and last-observed fields;
- lifecycle-specific notifications.

### Important safety corrections

Do not copy the upstream project's risky normalizations:

- do not collapse regional schedules to the earliest date;
- do not treat announcement date as first observed;
- do not default missing shutdown date to announcement date;
- do not merge records only by provider and model ID when region or API surface differs;
- do not reuse cached provider data as fresh data after a failed scrape;
- do not turn generic occurrences of the word `deprecated` into model records.

## 9. Cross-repository source map

### Already covered by Signal Forge

- OpenRouter catalogue;
- basic Arena roster and leaderboards;
- OpenAI news;
- Anthropic news;
- OpenAI and Anthropic status pages;
- generic GitHub commits, pull requests, and releases;
- npm and PyPI packages;
- selected Hugging Face and ModelScope repositories;
- OpenAI and Anthropic deprecation pages;
- immutable event and delivery storage.

### Partially covered

- Arena frontend and agent boards;
- Hugging Face benchmark data;
- Claude Code releases and changelog;
- Codex changelog and Skills;
- DeepSeek GitHub/npm/website channels;
- official model documentation tables;
- source freshness and collection continuity;
- cross-source story identity;
- source contribution metrics;
- benchmark evidence;
- vendor organization normalization.

### Missing but high value

- DeepSeek API changelog/news;
- Google DeepMind and Google AI feeds;
- Microsoft AI and NVIDIA AI feeds;
- OpenAI Skills and Codex changelog;
- Claude Code changelog and support release notes;
- Anthropic SDK release details;
- AWS/Gemini/Vertex/Azure/Groq/Cohere/xAI lifecycle sources;
- Artificial Analysis;
- Aider or LiveBench;
- OpenRouter usage/trending data, pending stable endpoint verification;
- Hugging Face model-card and metadata changes;
- GitHub discovery/trending, if bounded.

### Low-value or excluded

- generic media aggregation;
- AI Breakfast in its current failing state;
- large feed repackagers such as NewsNow and AI HOT;
- Reddit;
- X/Twitter;
- SocialData;
- TikHub;
- AgentMail;
- arbitrary personal watchlists;
- market/deal/career research.

## 10. Feature backlog

### P0: data and evidence safety

#### P0.1 Normalized record contract

Files:

- [src/events/store.ts](../src/events/store.ts)
- [tests/events.test.ts](../tests/events.test.ts)

Acceptance criteria:

- empty ID rejected;
- empty name rejected;
- duplicate ID rejected;
- rejected collection leaves all persistent state unchanged.

#### P0.2 Suspicious shrink detection

Files:

- [src/events/store.ts](../src/events/store.ts)
- [src/status.ts](../src/status.ts)
- [src/issues.ts](../src/issues.ts)
- [src/signalQuality.ts](../src/signalQuality.ts)
- one numbered migration under `src/storage/migrations/` if persistence is needed.

Acceptance criteria:

- full collection shrinking unexpectedly is not treated as ordinary removals;
- previous records remain available;
- append-only sources are not falsely rejected;
- a clear operator issue is exposed;
- no empty or malformed collection becomes an empty catalogue.

#### P0.3 Source authority

Add source authority to the existing registry. Do not change confidence automatically in the first implementation.

Acceptance criteria:

- authority visible in source status and operations;
- third-party evidence remains stored;
- third-party evidence cannot directly trigger a high-confidence interpretation;
- authority is not confused with source health.

#### P0.4 Fixture replay corpus

Add compact source fixtures and full-path tests. Prioritize silent data-loss and duplicate-delivery failures over coverage percentage.

### P1: story and notification quality

#### P1.1 Independent support summary

Add source-family and evidence coverage to stories. Count genuinely independent sources, not URLs.

#### P1.2 Conservative story merging

Use canonical URL, then same-vendor title similarity inside a short window, with model/vendor conflict guards. Store the relation reason as derived story data.

#### P1.3 Story-aware digest rendering

Render one story with multiple evidence links, while retaining all event IDs and delivery associations.

#### P1.4 Arena noise control

- suppress vote-only changes;
- compare dynamic metric objects independent of field order;
- suppress overlapping-confidence-interval score changes;
- preserve all raw score evidence.

#### P1.5 Event provenance in API views

Expose source URL directly in event and story operations. Do not invent a URL when legacy evidence has none.

### P1: official source coverage

#### P1.6 DeepSeek pack

Add API, website, GitHub, npm, and source-specific story correlation.

#### P1.7 Deprecation expansion

Add official provider collectors and structured lifecycle records.

#### P1.8 Official developer-tool feeds

Keep only high-signal official developer-tool feeds in direct source modules: Claude Code,
Anthropic SDK, Google DeepMind, NVIDIA and Hugging Face. General Google AI, Microsoft and static
Codex Skills pages were removed after the freshness and signal audit; the stale OpenAI developer
RSS was removed in favor of existing official release-note and news collectors.

### P2: independent evidence and discovery

#### P2.1 One benchmark lane

Start with a current Artificial Analysis or equivalent public benchmark surface. Add no benchmark until it has stable fixtures and demonstrable signal; add no second lane afterward without unique contribution.

#### P2.2 Hugging Face metadata

Track model-card and meaningful metadata changes. Keep likes/downloads as evidence or derived trends, not message-generating noise.

#### P2.3 Router usage/trending

Implement only after a stable public endpoint is verified. No browser automation or LLM extraction.

#### P2.4 Hacker News

Optional, free, low-confidence, digest-only, canonicalized, and never sufficient for `confirmed` evidence.

## 11. Implementation roadmap

### Stage 1: harden the collection boundary

One coherent change:

- normalized record validation;
- suspicious shrink detection;
- source authority metadata;
- collection result categories;
- source duration and last-non-empty metrics;
- replay fixtures.

This stage changes internal safety and operator visibility but should not materially change subscriber content.

### Stage 2: improve derived stories and notifications

One risk boundary:

- source-family support;
- evidence coverage;
- deterministic story relations;
- canonical URL/title merging;
- one story per digest;
- provenance links;
- Arena vote and confidence-interval filtering.

This stage changes subscriber-visible grouping, so it needs explicit replay tests for duplicate and ambiguous delivery behavior.

### Stage 3: add official DeepSeek and lifecycle coverage

Implement:

- `src/sources/deepseek.ts`;
- selected official DeepSeek GitHub watches;
- DeepSeek npm package;
- OpenAI per-model deprecations;
- normalized Anthropic lifecycle fields;
- AWS, Gemini, Vertex, Azure, Groq, Cohere, and xAI sources.

All external responses must use Zod validation or strict source-specific parsing. All changes remain inside the existing collection/event transaction.

### Stage 4: keep high-signal official product and vendor feeds

Keep:

- Google DeepMind;
- Claude Code changelog/releases;
- Anthropic SDKs;
- Hugging Face Blog;
- NVIDIA Generative AI.

Prefer RSS/Atom/official JSON. Use HTML only where the page is the official source and the parser can fail closed.

### Stage 5: add one independent benchmark and evaluate contribution

Add one benchmark lane, then measure:

- unique stories;
- independent corroboration;
- duplicate coverage;
- parser failure rate;
- source freshness;
- subscriber-visible notifications;
- maintenance cost.

Only add another benchmark if it contributes something materially different.

## 12. Cost and operations policy

### Allowed by default

- public RSS and Atom feeds;
- public JSON endpoints;
- official HTML and Markdown documentation;
- GitHub public APIs and Atom feeds within rate limits;
- Hugging Face public endpoints within rate limits;
- Hacker News Algolia at low volume;
- existing optional GitHub and Hugging Face tokens;
- existing optional summary model, bounded by the current budget.

### Not allowed by default

- paid social APIs;
- paid news APIs;
- private inboxes;
- browser automation against protected sites;
- unbounded feed discovery;
- LLM extraction of arbitrary external tables;
- public hosting or inbound listeners;
- credentials in source-specific URLs or logs.

### Request discipline

Every new collector must:

- use the existing HTTP client and cache;
- respect conditional requests and validators;
- have a bounded response size;
- distinguish transport failure from valid empty data;
- validate external data before persistence;
- register pacing and interval metadata;
- expose a source health state;
- include fixture tests;
- preserve the last good state when parsing fails.

## 13. Acceptance checklist for the finished work

The work is complete only when all of the following are true:

- no Reddit, X/Twitter, paid scraper, or private inbox integration was added;
- no second persistence system exists;
- no public listener or public deployment path was added;
- DeepSeek API, selected active GitHub repositories, npm, and Hugging Face signals correlate into stories;
- deprecation dates, replacement models, regions, and provider context are preserved;
- a failed or suspicious collection cannot create mass removals;
- vote-only Arena changes do not create subscriber notifications;
- score changes with overlapping confidence intervals are not noisy notifications;
- source authority is visible but does not replace confidence;
- independent support is derived from source families, not URL count;
- story merging never rewrites immutable event evidence;
- ambiguous delivery remains ambiguous and is not automatically repeated;
- source quality shows whether a source contributes unique signal;
- every new parser has malformed, empty, duplicate, and unchanged fixtures;
- `bun run check` passes;
- no Cyrillic appears in `src/`, docs, logs, or subscriber-facing output.

## Final recommendation

The selected direct implementation is now in the working tree:

1. harden normalized records and collection continuity;
2. add source authority and independent-support fields;
3. implement the DeepSeek API, active-repository, npm, and Hugging Face pack;
4. expand structured deprecations;
5. keep only the high-signal Claude Code, Anthropic SDK, Google DeepMind, NVIDIA, and Hugging Face feeds;
6. improve Arena noise filtering;
7. defer a benchmark lane until a current source survives freshness and contribution checks.

That sequence improves the product's actual advantage: early, public, evidence-backed signals with enough provenance to know what is fact, what is merely observed, and what still needs confirmation.

The remaining follow-up is measurement, not another source expansion: observe source freshness,
unique contribution and duplicate-story rate through `signal-quality`. Story-aware cross-source
digest grouping is implemented and covered by replay tests; the benchmark lane remains deliberately
deferred until a current public source passes freshness and contribution checks.
