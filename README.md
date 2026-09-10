# Signal Forge

Evidence-first monitoring for changes across the AI ecosystem.

Signal Forge watches model catalogs, arenas, package registries, GitHub repositories, documentation, official announcements, and platform status pages for meaningful changes.

Instead of forwarding every diff as news, it preserves the underlying before/after evidence, assigns confidence based on the source, correlates related signals, and delivers only events that pass the notification policy.

Built with Bun, TypeScript, and SQLite.

## What it detects

* First-party model catalogs from AI providers
* OpenRouter model availability and pricing
* Arena appearances, codenames, and leaderboard movement
* GitHub commits, pull requests, and releases
* npm and PyPI package releases
* Hugging Face and other open-weight registries
* Product documentation and changelogs
* Official vendor announcements
* Platform incidents and service status
* Model deprecations and lifecycle changes

GitHub and Hugging Face discovery run in shadow mode by default. They collect snapshots, events,
stories and metrics but never create subscriber delivery work until explicitly promoted.

## Why Signal Forge exists

AI products often change before there is a conventional announcement.

A model may appear in an API catalog before a blog post. A codename may surface in an arena before its identity is known. Documentation may expose a capability before it reaches a news feed. A package or repository may ship before broader coverage appears.

Signal Forge is designed to capture those early signals without overstating what they mean.

Each event retains its source and immutable before/after evidence.

Confidence is derived from the evidence:

* `observed`: visible in public technical evidence, but not independently confirmed
* `supported`: backed by an official statement or related source
* `confirmed`: present in a first-party product or API surface
* `shipped`: published as a release

An observation never becomes a stronger claim than its source supports.

## Intelligence layer

Signal Forge has a deterministic intelligence layer on top of immutable events:

* GitHub and Hugging Face discovery collectors find recent candidates without creating a second
  stream of evidence. GitHub discovery uses the existing `github` stream and Hugging Face discovery
  uses `weights`.
* Discovery sources calculate an attention score from recency, popularity and technical relevance.
  Attention is a triage measure, not confidence, and never changes source-derived confidence.
* Model Facts is a reproducible projection of the best known structured fields for a canonical model.
  Every fact retains its source, event ID, evidence type, confidence and observation time.
* Source-quality reports measure signal density, first-source wins, independent confirmation rate and
  median lead time. GitHub discovery queries share one source family, so four queries do not count as
  four independent confirmations.
* Hypotheses are deterministic interpretations of story timelines. They point to real supporting
  events but are never evidence themselves.
* Lifecycle deadlines and reminders are derived delivery work from deprecation evidence. They do
  not create synthetic evidence events and are idempotent across projection rebuilds.

## Example

A model might first appear as an unresolved arena codename, later show up in a provider catalog, and eventually ship as an official release.

Signal Forge keeps those observations separate while correlating them around the same identity as stronger evidence becomes available.

Example notification:

```text
🆕 New model available · GPT-5
OpenRouter · OpenAI

What changed
Listed and selectable.

Reader impact
Available to use from this catalogue.

Confirmed · availability catalogue
Detected a few minutes ago
```

## Signal, not noise

Not every detected change becomes a notification.

For example, insignificant pricing fluctuations can remain recorded in SQLite without generating an alert. Larger or materially significant changes remain visible.

Failed or malformed source responses are never interpreted as empty catalogs, and uncertain message deliveries are never blindly retried.

The goal is to preserve evidence while keeping the reader-facing signal useful.

## Architecture

```mermaid
flowchart LR
  A[Sources] --> B[Collections]
  B --> C[Canonical diff]
  C --> D[Immutable events]
  D --> E[Confidence and identity]
  E --> F[Correlation]
  F --> G[Notification policy]
  G --> H[Delivery]
```

The system keeps collection, event processing, persistence, rendering, and delivery separate.

Collectors do not know about Discord or Telegram. Storage does not depend on transport adapters. Architectural boundaries and circular dependencies are checked automatically in CI.

## Quick start

Requirements:

* Bun 1.3.14 or newer

```sh
git clone https://github.com/alexgetmancom/signal-forge.git
cd signal-forge

bun install --frozen-lockfile
cp signal-forge.example.json signal-forge.json

bun run check
bun run dev
```

The first observation establishes the baseline and does not emit change notifications. Later observations are compared against the stored state.

Some collectors require provider credentials. See the configuration section below for optional integrations.

## Source coverage

The current source registry covers:

* OpenRouter and optional first-party catalogs for OpenAI, Anthropic, and Gemini, plus the Vercel AI Gateway feed
* Arena appearances, leaderboards, and DesignArena categories
* Hugging Face open-weight repositories
* Recent global Hugging Face model discovery
* npm and PyPI packages
* GitHub commits, pull requests, and releases for selected repositories
* Recent GitHub discovery for artificial-intelligence, LLM, agent, and MCP repositories
* Official OpenAI Help Center and news, Anthropic Platform, Gemini API, xAI, Mistral, Groq, DeepSeek, Google DeepMind, NVIDIA, and Hugging Face release surfaces, plus Codex documentation and Claude Code/Anthropic SDK releases
* Provider lifecycle and deprecation pages for OpenAI, Anthropic, Google, AWS, Azure, Groq, Cohere, and xAI

Provider credentials and upstream availability determine which optional sources can run. A failed or malformed collection is never treated as an empty catalog; external responses are validated before they can change stored state.

## Configuration

Copy `.env.example` to `.env` and set only the credentials required by the sources and destinations you enable. Configure polling, source selection, and destinations in `signal-forge.json`:

```json
{
  "pollSeconds": 300,
  "sourceEnabled": {
    "openai": true,
    "anthropic": true,
    "gemini": true
  },
  "sourceMode": {},
  "destinations": []
}
```

API catalog collectors are requested by default. Set `sourceEnabled` to `false` for a source that is intentionally disabled; a requested source without its credential is reported as `missing` and is not scheduled.

`sourceEnabled` controls whether a collector runs. `sourceMode` controls delivery for a running
collector: `active` may create subscriber deliveries, while `shadow` still stores snapshots and
events and participates in stories and metrics but creates no subscriber deliveries. Discovery
sources default to `shadow`. Promote a source by editing the operator-owned configuration, for
example:

```json
{
  "sourceMode": {
    "discovery:github-ai": "active"
  }
}
```

There is no CLI command that edits configuration files.

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` for their catalogs. Set `DEEPSEEK_API_KEY` to enable one-sentence summaries for large, publishable diffs after deterministic noise filtering; a missing key or failed summary call leaves the original evidence unchanged and never blocks delivery. Discord and Telegram keep the title and compact source evidence alongside the optional summary.

Every Summary attempt is recorded with its event, source, stream, model, response status, token
usage, cache hit/miss counts, outcome and calculated USD cost. Inspect the local ledger with
`bun src/cli.ts deepseek-usage 30`, `/api/deepseek-usage?days=30`, or the `deepseek_usage` MCP
operation. The report also names the code path, selection rule and spend limits. Historical calls
from the old counter are retained as unpriced legacy attempts because their provider token usage
was never stored.

GitHub notifications show the commit or pull-request title, a one-sentence summary when a large diff warrants it, and compact change statistics; raw patch evidence remains internal. Set `GITHUB_TOKEN` to raise the GitHub request allowance from 60 to 5,000 per hour. Optional `github` entries accept `repo` and `paths`; the default repository is `openai/codex`. Set `HF_TOKEN` to use the account's Hub API allowance instead of the anonymous allowance shared by the machine's public address.

See [docs/discord.md](docs/discord.md) for Discord destination, channel, board, role, and permission configuration.

## Delivery

Signal Forge currently delivers reader-facing signals to Discord. Telegram support is implemented and tested but is not enabled in the production configuration.

Delivery is designed to avoid duplicate or misleading notifications. Successful sends are never retried, rate limits are respected, and ambiguous outcomes require explicit operator verification rather than automatic resending.

See [docs/discord.md](docs/discord.md) for channel configuration, status boards, role mentions, permissions, and delivery behavior.

## Operations

Signal Forge exposes the same operational model through CLI, HTTP, and MCP interfaces.

```sh
bun src/cli.ts status
bun src/cli.ts issues
bun src/cli.ts signal-quality 7
bun src/cli.ts code-analytics 7
bun src/cli.ts deepseek-usage 30
bun src/cli.ts stories
bun src/cli.ts models
bun src/cli.ts hypotheses
bun src/cli.ts deadlines
bun src/cli.ts deliveries-needing-verification
```

Operational endpoints require bearer-token authentication.

The system distinguishes between unavailable credentials, intentionally disabled sources, upstream restrictions, collection failures, and delivery failures instead of reducing them to a single healthy/unhealthy state.

Story views expose event IDs, `canonicalId`, `identityStatus`, and aliases so downstream publication workflows can fetch and evaluate the underlying evidence. Arena codenames remain unresolved until another source supplies a canonical identity.

## Reliability

Signal Forge is designed around external systems that fail in different ways.

Key safeguards include:

* immutable before/after event evidence
* validation before external responses can modify stored state
* conditional HTTP requests and response caching
* upstream pacing and rate-limit handling
* explicit source capability states
* versioned SQLite migrations
* delivery verification for uncertain send outcomes
* architecture checks in CI
* backup integrity verification

Snapshots, events, and delivery jobs commit in one SQLite transaction. Immutable assets are not requested again, and responses without validators are not treated as cacheable.

Instrumented runtime boundaries store bounded, hourly code-execution metrics for 90 days. The
report includes call counts, failures, total and average duration, min/max, approximate p50/p95,
last-seen timestamps, and an hourly timeline. Inspect it with `bun src/cli.ts code-analytics 7`,
`/api/code-analytics?days=7`, or the `code_analytics` MCP operation.
Sections are intentionally nested (for example, a source collection runs inside a worker), so
the report's totals are recorded span-time and are not a wall-clock sum.

DeepSeek Summary usage is retained in a local one-row-per-attempt ledger. It records one claim per event,
including failed and unclear responses, and calculates cost from the provider's returned token and
cache fields. A missing token breakdown is reported as estimated or unpriced rather than silently
counted as zero.

## Deployment

The production deployment, backup, restore, and operator procedures live in the [operator runbook](docs/runbook.md). Deployment-specific hosts, paths, and credentials stay outside the repository.

## Delivery semantics

The first observation establishes a baseline and is quiet; destinations receive future events only.

Successful sends are never retried. HTTP 429 responses honor retry timing. An uncertain external outcome is marked `ambiguous` and never automatically repeated; inspect the destination, require manual delivery verification, and record the final outcome without sending again.

Full event evidence remains in SQLite even when a message excerpt is truncated.

## HTTP / MCP API

For HTTP/MCP access, set `MCP_TOKEN` to at least 32 random characters and use `Authorization: Bearer <token>` with `/api/status`, `/api/events`, `/api/events/:id`, `/api/models`, `/api/models/*`, `/api/hypotheses`, `/api/hypotheses/:id`, `/api/deadlines`, `/api/code-analytics`, `/api/deepseek-usage`, or `/api/mcp`.

MCP operations: `status`, `events`, `event`, `deliveries`, `issues`, `capabilities`, `deliveries_needing_verification`, `require_delivery_verification`, `resolve_delivery_verification`, `signal_quality`, `code_analytics`, `deepseek_usage`, `stories`, `models`, `model`, `hypotheses`, `hypothesis`, and `lifecycle_deadlines`.

## Development

The main verification command runs formatting and lint checks, TypeScript validation, tests, migration checks, architecture checks, and the production build:

```sh
bun run check
```

Docker builds are also validated in CI.

Use a separate database and destination configuration for local development.

On a fresh checkout, create `.env` and `signal-forge.json` from their example files. Do not overwrite the deployment configuration in an existing checkout.

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run poll` collects once without sending the queue. Stop the development server before using it; run only one collector per database.

## Project status

Signal Forge is actively running and being evaluated against real-world signal quality.

Current engineering priorities include restore testing, longer-term signal-quality measurement, improved outage-duration tracking, and selective expansion of source coverage.

See [ROADMAP.md](ROADMAP.md) for current priorities.

## Documentation

* [docs/runbook.md](docs/runbook.md) — deployment, backup, restore, and operator procedures
* [docs/agent-workflow.md](docs/agent-workflow.md) — evidence handoff for downstream publication workflows
* [docs/discord.md](docs/discord.md) — Discord delivery, boards, roles, and channel configuration
* [ROADMAP.md](ROADMAP.md) — current engineering priorities
