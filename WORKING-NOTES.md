# Working Notes

Updated 2026-09-09 UTC. This is the current backlog and implementation record; historical audits
are not a second source of truth.

## Current state

Signal Forge is a Bun, TypeScript and SQLite observability service for AI model catalogues, arenas,
open-weight registries, packages, repositories, documentation, official news and platform health.
It collects immutable before/after evidence, assigns source-derived confidence, correlates related
events and delivers only changes that pass the notification policy.

The latest production verification passed:

- `bun run check`: 128 tests passed, 0 failed.
- Database schema version: 9.
- Health and readiness checks: passing.
- Actionable issues: none.
- Delivery state: 155 sent deliveries, no pending or ambiguous deliveries.
- Story reads are read-only; GitHub commit, pull request and release events are not merged into one
  repository-wide story.

## Completed

- Lifecycle events preserve `new`, `removed` and `changed` semantics with field-level before/after
  evidence.
- Events carry source, URL, provider, observed time, evidence type and normalized model identity.
- Confidence labels remain source-derived: `observed`, `supported`, `confirmed` and `shipped`.
- Arena codenames remain unresolved until another source supplies a canonical identity.
- GitHub correlation is conservative: repository identity alone does not merge commits, pull
  requests and releases.
- Story projection is rebuilt on event-bearing writes and at startup; `listStories()` performs no
  writes.
- Capabilities distinguish `disabled`, `missing` and `ready`, with source IDs such as `openai` and
  `gemini` rather than environment-variable names.
- Ambiguous delivery handling is named `require_delivery_verification`; it never resends a message.
- Small price changes are retained in SQLite but suppressed from Discord when they do not cross the
  configured absolute and relative thresholds.
- Multipart delivery ordering, HTTP caching, source backoff, health boards, outage alerts, role
  mentions, benchmark metadata, codename resolution and signal-quality reporting are implemented.
- Backups use a separate memory budget and verify the compressed database with SQLite integrity and
  event-count checks.

## Next work

Ordered by risk and reader value.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Run a real restore drill. | Restore a verified archive into a stopped test instance, run `integrity_check`, start it, and compare event counts and health reports. |
| Next | Observe signal quality for seven days. | Use `signal-quality 7` to decide whether DesignArena rank churn or another source needs batching, thresholds or a different notification policy. |
| Next | Preserve outage start time. | Store `failure_started_at` separately from the latest observation so issue duration is accurate. |
| Owner decision | Google catalogue. | Choose Vertex AI with a billed service account or accept OpenRouter as the Google model source. |
| Owner decision | Vercel AI Gateway. | Decide whether the incomplete upstream response is worth another parser or should remain disabled. |
| Next | Add a welcome channel. | Explain the channel map, event types, confidence labels and how readers can use the feed. |
| Later | More repositories. | Add only repositories with a clear reader benefit and one explicit configuration entry each. |
| Later | History commands. | Add `/latest` and `/search` only after the event and identity model remains useful in daily use. |

## Deferred

- Telegram delivery is implemented and tested but has no configured destination; the audience is on
  Discord.
- Cloud catalogues such as Bedrock, Vertex and Azure AI Foundry require credentials and a clear
  reader need.
- Mobile app releases, individual PR authors, additional status providers and a public report site
  remain optional expansions.
- A dedicated removals role remains deferred even though removal evidence is retained.

## Source coverage

The current registry covers:

- OpenRouter, OpenAI and Anthropic catalogues, with Gemini configured but blocked by the upstream
  location response and Vercel Gateway awaiting an owner decision.
- Hugging Face and ModelScope open-weight repositories.
- Arena, Arena leaderboards and DesignArena categories.
- npm, PyPI and GitHub activity for selected AI tools and repositories.
- Official OpenAI and Anthropic news, Cursor changelog, Codex documentation and Claude web strings.
- OpenAI and Anthropic platform health and lifecycle/deprecation sources.

A failed or malformed collection is never treated as an empty catalogue. External responses are
validated before they can change stored state.
