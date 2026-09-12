# Roadmap

Updated 2026-09-12 UTC. This is the current backlog and implementation record; `docs/competitors/`
records what the competitor audit already settled and is not a second source of truth.

## Current state

Signal Forge is a Bun, TypeScript and SQLite observability service for AI model catalogs, arenas,
open-weight registries, packages, repositories, documentation, official news and platform health.
It collects immutable before/after evidence, assigns source-derived confidence, correlates related
events and delivers only changes that pass the notification policy.

Production health and readiness checks are passing. The full automated test suite passes on the
current `main` branch with no known actionable issues.

- Story reads are read-only; GitHub commit, pull request and release events are not merged into one
  repository-wide story.
- Eighty sources are registered. Three fail persistently and all three are blocked upstream
  rather than broken here: `gemini` (HTTP 400), `vercel-gateway` and `status:anthropic` (bot
  protection).

## Completed

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
- Discord cards say how solid an observation is in a sentence keyed on evidence type, above the
  line saying what it means. The footer keeps the machine-readable labels.
- The vendor map covers the makers Arena actually carries, and short patterns are anchored so `xai`
  cannot claim SpaceXAI.
- Codex usage-limit resets are collected from the `codex-resets` tracker: the whole tracked history
  lands as the first, silent baseline, and only a new announcement speaks. A reset is announced in
  two steps by the same person, so one announcement carries the stage it has reached: promised,
  then applied. Both steps are launches and both reach New; only the applied one mentions the
  vendor role, because a promise is worth reading and not worth interrupting. The AI-classified
  watch forecast stays out of the records entirely. Its scheduled
  reset and AI-classified watch forecast are retained as evidence and never become records, because
  the tracker's own documentation says neither implies a reset happened.

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
  unused files and dependencies, and a high-severity dependency audit; `.githooks/pre-push` runs it.
- `scripts/rehearse-migration.ts` runs a migration against a copy of a real database and reports
  how many stored `records.body` values it moved.

## Next work

Ordered by risk and reader value. Measurements behind these entries come from the production
database and are dated, because a priority derived from a number that has since moved is not a
priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | A last-reset board. | One status message, edited in place, naming when each tracked vendor last reset usage limits. Worth building when a second vendor's resets are collected; with one row it is a card that already exists. |
| Next | Preserve outage start time. | Store `failure_started_at` separately from the latest observation so issue duration is accurate. |
| Owner decision | Google catalogue. | `gemini` has never succeeded: HTTP 400 from every address this project can reach. Choose Vertex AI with a billed service account, route around the block, or accept OpenRouter as the Google source. |
| Owner decision | Vercel AI Gateway. | Has never succeeded. Decide whether the incomplete upstream response is worth another parser or should be removed. |
| Owner decision | Provider catalogue keys. | `xai`, `moonshot`, `mistral` and `groq` catalogues are implemented and waiting on keys; Artificial Analysis is implemented and blocked by its own IP filter. |
| Later | More reset sources. | Add Z.ai, xAI and Meta reset surfaces once each has one address that can be read and validated; each arrives as its own source with its own authority, never merged into the Codex tracker's family. |
| Later | Measure the watch forecast. | The tracker's AI-classified watch is retained in snapshots but never delivered. Decide on measurement: how many `strong` watches were followed by a reset inside their own window. |
| Later | An evidence type for resets. | `events.evidence_type` carries a CHECK constraint, so a new member needs a rebuild of a table a dozen others reference. Resets store `unknown` and say what they are in the card's own words until that rebuild is worth one move. |
| Later | Add a welcome channel. | Explain the channel map, event types, confidence labels and how readers can use the feed. |
| Later | ModelScope verdict. | Keep or remove on measured lead time once it has produced a week of first sightings. |
| Later | More repositories. | Add only repositories with a clear reader benefit and one explicit configuration entry each. |
| Later | History commands. | Add `/latest` and `/search` only after the event and identity model remains useful in daily use. |

## Settled by measurement

Kept because the reasoning cost real observation and is easy to re-litigate from intuition.

- **Shadow discovery stays in the shadow.** `discovery:huggingface-recent` produced 7,723 stories in
  seven days; 73 were touched by another source and all 73 were false matches on a base model's name
  carried by a third-party derivative. Its apparent lead time was an artefact of being the only
  source present. It now correlates only with itself.
- **A source-count badge on a card is not worth building.** Of the cards that actually reached a
  reader, 0% in New and 10% in Codenames had a second independent source at send time, and 18% would
  have carried a permanently wrong count because confirmation arrived a median 8.2 hours after the
  message was already sent and cards are not edited. Source-derived confidence already separates
  rumour from fact and is correct from the first second; it only needs plainer wording.
- **The reader channels are routed correctly.** New, Codenames, Evidence and Changes carry 12, 9,
  16 and 63 cards a day respectively, and each carries what its name promises: Evidence is
  documentation diffs and package versions, and leaderboard churn is already in Changes. An earlier
  reading that made Evidence 89% leaderboard counted events that were members of a delivered batch
  rather than events the destination actually rendered — a batch is filtered again per destination,
  and any measurement that skips `batch_events.signal` overstates every channel.
- **Site pages are not early warning.** `pages:openai` leads by 0.1 hours: the page appears when
  everyone else sees it. Packages lead by 17.9 hours and are worth the enrichment.

## Ideas

Not scheduled and not started. Written down so they stop being re-derived from scratch, with what
is already known about each.

- **ModelScope verdict.** Keep or remove on measured lead time. It has produced no first sighting
  worth a card so far; `lead-time 7` decides it once the source has a full week behind it.
- **Welcome channel.** One message explaining the channel map, what the standing sentences mean and
  how to follow a single vendor. More useful now that a card says "Seen in a reseller's catalogue"
  rather than "Confidence: observed".
- **Incident cards edited in place across stages.** An incident currently posts a card per stage;
  the status boards already show that editing one message reads better than a growing log.
- **Shorter snapshot body lifetime for the two heavy sources.** `claude-web` and `npm:@openai/codex`
  dominate snapshot bytes. Fourteen days for those two, ninety for everything else, instead of the
  size cap and receipt design that was deferred.
- **Hugging Face model-card metadata**, **OpenRouter trending** (needs a stable public endpoint) and
  **Hacker News** (digest-only, never sufficient for `confirmed`), all from the competitor audit.
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
