# Roadmap

Updated 2026-09-13 UTC. This is the current backlog and implementation record; `docs/competitors/`
records what the competitor audit already settled and is not a second source of truth.

## Current state

Signal Forge is a Bun, TypeScript and SQLite observability service for AI model catalogs, arenas,
open-weight registries, packages, repositories, documentation, official news and platform health.
It collects immutable before/after evidence, assigns source-derived confidence, correlates related
events and delivers only changes that pass the notification policy.

Production health and readiness checks are passing. The full automated test suite passes on the
current `main` branch with no known actionable issues.

The Moonshot source is still wired to the legacy `https://api.moonshot.ai/v1/models` catalogue.
The production `MOONSHOT_API_KEY` is accepted there and currently exposes only `kimi-k2.6` and
`kimi-k2.7-code`. The current Kimi API uses `https://api.moonshot.cn/v1` with a key created on
`platform.kimi.com`; its catalogue includes `kimi-k3`, `kimi-k2.7-code`,
`kimi-k2.7-code-highspeed` and `kimi-k2.6`. Kimi Code exposes K2.8 Preview as
`kimi-for-coding` through the separate `https://api.kimi.com/coding/v1` membership API. This is
an integration gap, not evidence that those models are unavailable.

- Story reads are read-only; GitHub commit, pull request and release events are not merged into one
  repository-wide story.
- Eighty sources are registered. Three fail persistently and all three are blocked upstream
  rather than broken here: `gemini` (HTTP 400), `vercel-gateway` and `status:anthropic` (bot
  protection).

## Completed

- Cards and the weekly recap print the name of a thing, not the catalogue key for it, while an
  Arena codename and a repository id keep their exact characters.
- A record re-keyed by its source is recognised by its body and stays quiet on both halves, so a
  catalogue renaming its rows no longer reads as a wave of arrivals and removals.
- The recap reads a week back by maker, and counts as an arrival only what a maker offered: billing
  tiers, aliases, dated snapshots, numbered duplicate rows, third-party quantisations training
  checkpoints, artefacts a registry declares no pipeline for and somebody's fine-tune of a model
  that already arrived are excluded. Price lines are read against the price charged before, skip
  cached-read rates, and are withheld entirely when a subject's rows moved in both directions.
- A delivery that failed or came back ambiguous raises an alert in the private problem channel,
  carrying the platform's own words. Nothing retries those, so they were previously invisible.
- The nightly backup copies `signal-forge.json` beside the database snapshot and rotates it with the
  archives.
- `channel_mix` reports what each destination actually carried: events and delivered events per
  signal class, the share of sent messages that could say another source saw it first, and how many
  promotions the invited room produced.
- Lifecycle events preserve `new`, `removed` and `changed` semantics with field-level before/after
  evidence.
- Events carry source, URL, provider, observed time, evidence type and normalized model identity.
- Confidence labels remain source-derived: `observed`, `supported`, `confirmed` and `shipped`.
- Arena codenames remain unresolved until another source supplies a canonical identity.
- GitHub correlation is conservative: repository identity alone does not merge commits, pull
  requests and releases.
- Story projection processes appended events incrementally and rebuilds at startup or after an
  out-of-order timestamp; `listStories()` performs no writes.
- Routine digests are story-aware: one correlated story is rendered once with all retained evidence
  links, while unrelated events remain separate.
- Capabilities distinguish `disabled`, `missing` and `ready`, with source IDs such as `openai` and
  `gemini` rather than environment-variable names.
- Ambiguous delivery handling is named `require_delivery_verification`; it never resends a message.
- Manual delivery verification can record a final `sent` or `failed` outcome without resending.
- Small price changes are retained in SQLite but suppressed from Discord when they do not cross the
  configured absolute and relative thresholds.
- Multipart delivery ordering, HTTP caching, source backoff, health boards, outage alerts, role
  mentions, benchmark metadata, codename resolution and signal-quality reporting are implemented.
- Signal-quality reports include source freshness, unique-story contribution, corroboration and
  duplicate-story rate, attributed correctly when a digest contains multiple sources.
- Collection boundaries reject malformed normalized records and suspicious catalogue shrinkage;
  source authority, degraded health, and independent story evidence are visible to operators.
- DeepSeek API, website, npm and Hugging Face signals are registered alongside official
  lifecycle pages for Google, AWS, Azure, Groq, Cohere and xAI.
- Official developer feeds cover OpenAI Codex and API changelogs, Claude Code, Anthropic SDK releases
  and Hugging Face; stale general feeds and the undated Aider benchmark were removed.
- Optional DeepSeek summaries are generated for large, publishable diffs after deterministic noise
  filtering when `DEEPSEEK_API_KEY` is configured; Discord and Telegram show the title, short
  summary and compact evidence while raw patch details remain internal.
- Documentation diffs normalize Markdown bullets and suppress changes with no meaningful
  user-facing strings; Codex documentation is labelled as documentation rather than interface text.
- Backups use a separate memory budget and verify the compressed database with SQLite integrity and
  event-count checks.
- Source shadow mode separates collector execution from subscriber delivery. Shadow sources still
  persist snapshots, events, stories and source-quality metrics.
- Deterministic GitHub and Hugging Face discovery collect recent candidates in shadow mode, with
  attention scores that remain separate from source-derived confidence.
- Model Facts preserves structured canonical-model fields with exact event provenance and
  deterministic precedence and conflict records.
- Source-quality reports include signal density, first-source wins, independent confirmation rate
  and median lead time by source family.
- Hypotheses derive emerging and strengthening interpretations from independent story evidence;
  confirmations resolve them without creating synthetic events.
- Lifecycle deadlines and idempotent 30-, 7- and 1-day reminders derive delivery work from
  structured lifecycle evidence.
- Every suppressed event records the rule that stopped it and the same decision in a reader's words;
  a status board counts them beside the events that actually spoke.
- Snapshots are stored gzipped and deduplicated by hash, bodies expire after 90 days, the HTTP cache
  is bounded, and shadow candidates that never reached a batch are pruned.
- Sub-threshold price moves accumulate against a weekly baseline, so drift that never crosses the
  threshold in one step is still reported once it adds up.
- Minor incidents speak only on start and resolution; severe and resolved incidents bypass the digest.
- A changed field whose value survives normalization to letters and digits is not reported.
- Package releases are enriched with their upstream release notes before the card is rendered.
- `scripts/restore-drill.sh` restores the newest archive into a throwaway instance with no network,
  checks integrity and provenance, boots it, rebuilds every derived view and destroys the copy.
- An outage is dated from its first failure rather than from the last confirmation of it, so a
  source that has never succeeded stops reporting that it broke a moment ago.
- Discord cards say how solid an observation is in a sentence keyed on evidence type, above the
  line saying what it means. The footer keeps the machine-readable labels.
- The vendor map covers the makers Arena actually carries, and short patterns are anchored so `xai`
  cannot claim SpaceXAI.
- Codex usage-limit resets are collected from the `codex-resets` tracker: the whole tracked history
  lands as the first, silent baseline, and only a new announcement speaks. A reset is announced in
  two steps by the same person, so one announcement carries the stage it has reached: promised,
  then applied. Both steps are launches and both reach New; only the applied one mentions the
  vendor role, because a promise is worth reading and not worth interrupting. The promise and the
  fact are the whole of what this source is for: they are the words of the OpenAI engineer who runs
  Codex, and a promise from him has never failed to arrive -- only to arrive later than it said.
  The tracker's own AI-classified watch forecast is a different kind of thing and is wanted by
  nobody here. It stays out of the records entirely, alongside the scheduled reset, retained as
  evidence and never delivered, because the tracker's own documentation says neither implies a
  reset happened. This is settled, not deferred: there is nothing to measure and no plan to deliver
  it.

- Every operation is one registry entry; the CLI dispatch and its usage lines, the HTTP routes, the
  MCP tool list and the `guide` catalog are projections of it. `mutates` marks an operation that
  changes stored state, and `agent` keeps credential and host operations off the MCP surface.
- `guide` answers with sections, a symptom index and what to do when the database is unusable;
  `doctor` answers whether this deployment is configured, has a database and has a verified backup.
- The nightly backup writes a marker after verifying an archive. `doctor` reads it and `issues`
  raises `backup_stale`, so a backup job that stopped is visible before the day it is needed.
- Stored instants are ISO-8601 UTC, enforced by database triggers on every timestamp column;
  `date-integrity` reports rows written before the shape was enforced.
- A credential an upstream refused opens a circuit on the capability rather than the source: every
  source carrying it stops, `capabilities` reports `rejected`, and only the owner clears it.
- One collection cycle runs at a time, under a database lease that a crashed holder releases.
- Every operator mutation is journalled with the surface it was run from.
- `bun run check` also enforces English-only sources, that only `config.ts` reads `process.env`,
  the layer boundaries in `.dependency-cruiser.jsonc` -- including that Hono is imported by
  `http.ts` alone and that nothing in `src/` imports a test helper -- a clean knip report, and a
  high-severity dependency audit. A relative import the graph cannot resolve is itself a violation,
  so a rule cannot stop holding quietly. `scripts/check-steps.ts` is the list of what it runs, in
  groups that run at once; the whole gate is about three seconds. Lefthook runs it on push, and on
  commit runs Biome over the staged files and gitleaks over the staged diff.
- A mention means a model. `launch` covers catalogues, weights, usage limits coming back and
  severe outages; software around the models is `release` and a vendor's prose is `article`, and
  neither interrupts. Newsroom posts are never launches, so no feed category is parsed and no
  `records.body` migration was needed.
- A price move of a quarter or more is delivered on sight; smaller ones stay in the hourly digest,
  and moves under the publication threshold are still suppressed entirely.
- `scripts/rehearse-migration.ts` runs a migration against a copy of a real database and reports
  how many stored `records.body` values it moved.

## Next work

Ordered by risk and reader value. Measurements behind these entries come from the production
database and are dated, because a priority derived from a number that has since moved is not a
priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | A last-reset board. | One status message, edited in place, naming when each tracked vendor last reset usage limits. Worth building when a second vendor's resets are collected; with one row it is a card that already exists. |
| Owner decision | Google catalogue. | `gemini` has never succeeded because of geography, established 2026-09-13 with the configured key from the production container: `generativelanguage.googleapis.com` answers `FAILED_PRECONDITION`, `User location is not supported for the API use`. Probing the same endpoint with a deliberately invalid key returns `API key not valid` instead, so the key is checked before the region and only a real key reveals the refusal -- an earlier read of that first message as "nothing is blocked" was wrong. The refusal stands on every house exit: Google reports `RU` through all four tunnels, including two whose addresses geolocate to Germany. Choose between Vertex AI with a billed service account, an exit Google reads as outside Russia, and accepting OpenRouter as the Google source. |
| Owner decision | Vercel AI Gateway. | Has never succeeded. Decide whether the incomplete upstream response is worth another parser or should be removed. |
| Next | Kimi API migration and provider catalogue credentials. | Replace the legacy Moonshot endpoint and key path with `https://api.moonshot.cn/v1` and a key from `platform.kimi.com`, then verify that `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` and `kimi-k2.6` appear in `models`. Add a separate Kimi Code source with its own credential only if K2.8 Preview (`kimi-for-coding`) belongs in coverage. Production now contains credentials for the existing xAI, Moonshot, Mistral and Groq collectors; verify each source's next successful poll. Artificial Analysis remains the only configured catalogue capability missing a credential. |
| Later | Wire newly supplied provider credentials. | `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY` and `CEREBRAS_API_KEY` are present in production but are not registered capabilities or collectors. `OPENROUTER_API_KEY` is also present, while the current OpenRouter source does not require it. Add each provider only with a concrete source, validated response and a passing production status; an environment variable alone is not an integration. |
| Later | More reset sources. | Add Z.ai, xAI and Meta reset surfaces once each has one address that can be read and validated; each arrives as its own source with its own authority, never merged into the Codex tracker's family. |
| Later | An evidence type for resets. | `events.evidence_type` carries a CHECK constraint, so a new member needs a rebuild of a table a dozen others reference. Resets store `unknown` and say what they are in the card's own words until that rebuild is worth one move. |
| Later | Shutdown dates that reach the reminder engine. | Deprecations are `🕵scouts` material: a retirement is read by whoever runs the model being retired, and the public wire is for what a reader can start using. That caps the value of this work, which is why it moved from Next to Later. The reminder engine, `lifecycle_deadlines` and idempotent 30/7/1-day reminders already exist; the extraction does not. `parseOpenAIDeprecations()` keeps the prose but extracts no shutdown or replacement field, and the `lifecycle.ts` fallback reads ISO dates, not `October 1, 2026`. Event 9163 announced the GPT-5.4-Cyber shutdown and its replacement in `summary` alone and left `lifecycle_deadlines` at nine rows. Done when announcement, deprecation and shutdown dates are told apart from the source's own structure, an ambiguous multi-model or multi-date notice stays unprojected rather than guessing, affected stored records are migrated and projections rebuilt in the same move, and event 9163 yields the right date and successor. Routing `reminder` to a destination and an upcoming-shutdown block in `status` are a separate owner decision, not part of the parsing. |
| Next | Read the wire back in a week. | `channel_mix 7`, taken no earlier than 2026-09-21, answers what the two channels carried after the routing changed: volumes per class, the lead-time share, and whether the invited room promoted anything at all. Done when the numbers are recorded here with their date and `change` is either returned to the public channel or left in `🕵scouts` on the evidence rather than on one morning's screenshot. |
| Later | ModelScope verdict. | Keep or remove on measured lead time once it has produced a week of first sightings. |
| Later | More repositories. | Add only repositories with a clear reader benefit and one explicit configuration entry each. |
| Later | History commands. | Add `/latest` and `/search` only after the event and identity model remains useful in daily use. |

## Settled by measurement

- **The scouts grade what a machine cannot.** Promotion by reaction is not a popularity contest
  bolted onto the feed: source-derived confidence answers "can this be trusted", and it cannot
  answer "is this worth a stranger's attention", which is the whole question an early sighting
  raises. The room answers it, the owner overrides it, and the machine keeps deciding everything it
  is actually able to decide. Reactions are polled over the REST API rather than listened for on a
  gateway socket, which keeps the outbound-only boundary intact and costs one request per cycle.


Kept because the reasoning cost real observation and is easy to re-litigate from intuition.

- **The story correlation fallback is ordered by position on purpose, not by recency.** When an
  event matches several open stories, the one latest in the projection wins -- which in practice is
  the story created by the same collection pass, and so the neighbouring record from the same
  upstream. Indexing the search by `lastTime` instead looks like the obvious optimisation and is a
  behaviour change: measured 2026-09-13 on a copy of production, the fallback found a match 151
  times over 11,485 events and 22 of those 151 would land in a different story. The samples say
  which order is right -- recency merged `claude sonnet 4 6` into `claude sonnet 5`,
  `claude fable 5 1` into `claude fable 5`, and `gemini 3 pro image preview` into
  `gemini 3 7 flash`, because a busy story always has the newest last event and matches loosely on
  title terms. Position order is the one that keeps distinct models apart.

- **dependency-cruiser cannot be installed here, and the reason is not preference.** Its own graph
  builder needs the TypeScript compiler API at `typescript@>=2 <7`; this repository is on
  TypeScript 7, whose npm package ships a Go binary and a CLI and no JS API at all -- `require`ing
  it yields two keys, `version` and `versionMajorMinor`. Installed and pointed at `src/`, it cruised
  0 modules and said so. Adopting it means vendoring a second, older TypeScript purely to parse the
  code the real compiler already parses. `scripts/check-architecture.ts` reads the same rules file
  instead, and the day dependency-cruiser supports TypeScript 7 the rules move across untouched.

- **Shadow discovery stays in the shadow.** `discovery:huggingface-recent` produced 7,723 stories in
  seven days; 73 were touched by another source and all 73 were false matches on a base model's name
  carried by a third-party derivative. Its apparent lead time was an artefact of being the only
  source present. It now correlates only with itself.
- **A source-count badge on a card is not worth building.** Of the cards that actually reached a
  reader, 0% in New and 10% in Codenames had a second independent source at send time, and 18% would
  have carried a permanently wrong count because confirmation arrived a median 8.2 hours after the
  message was already sent and cards are not edited. Source-derived confidence already separates
  rumour from fact and is correct from the first second; it only needs plainer wording.
- **The reader channels are routed correctly.** `🚀launches`, `🕵codenames`, `🔍traces` and
  `📊price-and-ranks` -- renamed from New, Codenames, Evidence and Changes, same four classes --
  carry 12, 9, 16 and 63 cards a day respectively, and each carries what its name promises:
  `🔍traces` is documentation diffs and package versions, and leaderboard churn is already in
  `📊price-and-ranks`. An earlier
  reading that made Evidence 89% leaderboard counted events that were members of a delivered batch
  rather than events the destination actually rendered — a batch is filtered again per destination,
  and any measurement that skips `batch_events.signal` overstates every channel.
- **One public channel, one invited one.** The four reader channels became `🚀signals` (public;
  `launch` and `change`) and `🕵scouts` (invited; `codename`, `release`, `article`, `evidence`),
  with `📡status` behind an opt-in role. Reasoning: an audience arrives for models, so the public
  wire carries models and the numbers attached to them, and everything early or small goes to a room
  of invited readers who came for exactly that. `🔍traces` and `📊price-and-ranks` were deleted by
  hand; their history is gone. The classes stayed independent of the channels -- eight of them
  behind three destinations -- because routing is a line in `signal-forge.json` and reversing a
  channel decision must never need a deployment.
- **A newsroom post is never a launch.** `openai-news`, `anthropic-news` and `huggingface-blog-feed`
  are `article` whatever they announce. The alternative was parsing OpenAI's feed category, measured
  on 2026-09-13 across 1192 items: `category` is present on 1031 of them and `Product` (163) and
  `Release` (7) are cleanly releases, while `API`, `ChatGPT` and the 161 uncategorised items are
  customer stories. It would have worked, and it was not needed: a model a reader can use appears in
  the vendor catalogue, so the post is commentary. Anthropic could not have been fixed that way at
  all -- nine of its ten visible posts carry the subject "Announcements", including a board
  appointment and a policy position. Skipping it also skipped a `records.body` migration.
- **`launch` and `codename` stay separate classes.** They were going to be merged, on the reasoning
  that both ping and a channel earns its place only when a reader would set a different notification
  level on it. Rejected: the ping is the same but the trust is not, and a person who came for
  released models does not want arena sightings arriving with the same weight. Lumina, the closest
  competitor, keeps `official-ai-news` and `codenames` apart for the same reason. The separation now
  carries more than notification: it is the line between the public wire and the invited room.
  Competitors all split by source instead (`api-models`, `arena`, `subpages`, `app-diffs`); with
  thirteen streams that is a dozen channels, it scatters the mentions, and it defeats the
  cross-source story grouping that they do not have.
- **Cross-source repetition settled itself when the channels changed.** A page discovery and the
  news post about it used to speak in both Codenames and New, because `repeatsDeliveredStory()`
  only looks at previous deliveries to the same destination. Both classes now land in `🕵scouts`,
  one destination, where that check already works and the two events render as one story. A repeat
  between `🚀signals` and `🕵scouts` remains possible and is wanted: the public channel and the
  invited room are different audiences, and each is owed the story once.
- **No welcome channel.** The channel map lives in each channel's Discord topic, which is where a
  reader already looks and costs no sixth entry in the sidebar. A fifth status board carrying the
  same text was considered and rejected as clutter in a channel that exists to be glanced at.
- **Site pages are not early warning.** `pages:openai` leads by 0.1 hours: the page appears when
  everyone else sees it. Packages lead by 17.9 hours and are worth the enrichment.

## Ideas

Not scheduled and not started. Written down so they stop being re-derived from scratch, with what
is already known about each.

- **ModelScope verdict.** Keep or remove on measured lead time. It has produced no first sighting
  worth a card so far; `lead-time 7` decides it once the source has a full week behind it.
- **Incident cards edited in place across stages.** A severe incident posts a card per stage in
  `🚀launches`; the status boards already show that editing one message reads better than a growing
  log. Everything the vendor grades below severe is class `incident`, which no destination
  subscribes to, so it now lives only on the Platform health board.
- **Shorter snapshot body lifetime for the two heavy sources.** `claude-web` and `npm:@openai/codex`
  dominate snapshot bytes. Fourteen days for those two, ninety for everything else, instead of the
  size cap and receipt design that was deferred.
- **Hugging Face model-card metadata**, **OpenRouter trending** (needs a stable public endpoint) and
  **Hacker News** (digest-only, never sufficient for `confirmed`), all from the competitor audit.
- **A weekly recap in the public channel.** Done. One message per week, its own `batches.kind`,
  identity is the period it covers. What is not there yet: the lead the scouts had on each arrival,
  which needs the resolution links below.
- **A human verdict from the invited room.** A stealth model on an arena cannot be called by API,
  so no benchmark of ours can reach it -- but the scouts can, by hand. A codename card carrying a
  fixed prompt kit chosen from the arena's own modality flags (`output.image` against `output.web`
  against text, already in the record), and a reaction rubric the promotion worker tallies, turns
  the room into the evaluation. The verdict then travels with the reveal, which already links back
  to the sighting, and gives two measurements nobody else has: which source produces signals people
  confirm, and which scout is right most often. Not to be confused with `confidence`, which is
  source-derived and true from the first second.
- **A compact significant-change summary.** Partly answered: a move of a quarter or more now
  arrives on sight. What remains is the summary of everything smaller. Real material exists -- Qwen3.8 27B input $0.42 to
  $0.21 per million, DeepSeek V4 Flash 0731 output $0.28 to $0.08, Kimi Latest output $7.70 to
  $11.90, Mistral Small 3.2 context 131K to 256K. But hourly digests, thresholds, oscillation
  filtering and comparison against the last reader-visible baseline already exist and are not to be
  reimplemented, a persisted daily summary needs a new `batches.kind` member and an explicit
  period-and-destination identity, and Changes carrying what its name promises is already settled by
  measurement. No second sender and no independent cron. A universal top-five ranking is not wanted.
- **`selectable: false -> true` in an API catalogue classifies as `change`.** Possibly worth making
  a codename instead, but production history to 2026-09-12 contained no such API transition: all six
  observed transitions were Arena events. A code improvement, not a production-proven defect.
- **Regional lifecycle schedules.** A deprecation with different dates per region is stored as one
  record with one date, which understates the ones that matter most.

## Deferred

- Telegram delivery is implemented and tested but has no configured destination; the audience is on
  Discord.
- Cloud catalogues such as Bedrock, Vertex and Azure AI Foundry require credentials and a clear
  reader need.
- Mobile app releases, individual PR authors, additional status providers and a public report site
  remain optional expansions.
- A dedicated removals role remains deferred even though removal evidence is retained.
- LLM relevance verification is intentionally deferred until at least seven days of deterministic
  discovery density, confirmation rate, first-source wins and lead-time measurements exist.

## Source coverage

The current registry covers:

- OpenRouter, OpenAI and Anthropic catalogues, with Gemini configured but blocked by the upstream
  location response; the Vercel AI Gateway feed remains enabled.
- Hugging Face open-weight repositories.
- Arena, Arena leaderboards and DesignArena categories.
- npm, PyPI and GitHub activity for selected AI tools and repositories.
- Official OpenAI news, ChatGPT release notes, Codex and API changelogs, Anthropic Platform release notes, Gemini API changelog,
  xAI, Mistral, Groq and DeepSeek API release surfaces; Codex documentation, Claude Code, Anthropic SDK
  and Hugging Face developer feeds.
- OpenAI, Anthropic, Google, AWS, Azure, Groq, Cohere and xAI lifecycle/deprecation sources.
- Arena leaderboard observations, with selected DeepSeek npm channels.
- GitHub discovery for artificial-intelligence, LLM, agent and MCP repositories, plus recent global
  Hugging Face model discovery; both default to shadow mode. The Hugging Face feed correlates only
  with itself.
- Vendor site pages watched for new URLs appearing before the announcement does.
- Codex usage-limit resets, from the third-party tracker that keeps the announcements with times.
- Direct provider catalogues for xAI, Moonshot, Mistral, Groq and Z.ai, and Artificial Analysis,
  each enabled by its own key and inert without it.

A failed or malformed collection is never treated as an empty catalogue. External responses are
validated before they can change stored state.
