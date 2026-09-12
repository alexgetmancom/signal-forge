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
- Seventy-nine sources are registered. Three fail persistently and all three are blocked upstream
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

## Next work

Ordered by risk and reader value. Measurements behind these entries come from the production
database and are dated, because a priority derived from a number that has since moved is not a
priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Run a real restore drill. | Restore a verified archive into a stopped test instance, run `integrity_check`, start it, and compare event counts and health reports. |
| Next | Preserve outage start time. | Store `failure_started_at` separately from the latest observation so issue duration is accurate. |
| Next | Make confidence legible on the card. | Render `observed`, `supported`, `confirmed` and `shipped` as a sentence a non-specialist reads, instead of the footer's "Confidence: observed". |
| Owner decision | Google catalogue. | `gemini` has never succeeded: HTTP 400 from every address this project can reach. Choose Vertex AI with a billed service account, route around the block, or accept OpenRouter as the Google source. |
| Owner decision | Vercel AI Gateway. | Has never succeeded. Decide whether the incomplete upstream response is worth another parser or should be removed. |
| Owner decision | Provider catalogue keys. | `xai`, `moonshot`, `mistral` and `groq` catalogues are implemented and waiting on keys; Artificial Analysis is implemented and blocked by its own IP filter. |
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
- **Site pages are not early warning.** `pages:openai` leads by 0.1 hours: the page appears when
  everyone else sees it. Packages lead by 17.9 hours and are worth the enrichment.

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
- Direct provider catalogues for xAI, Moonshot, Mistral, Groq and Z.ai, and Artificial Analysis,
  each enabled by its own key and inert without it.

A failed or malformed collection is never treated as an empty catalogue. External responses are
validated before they can change stored state.
