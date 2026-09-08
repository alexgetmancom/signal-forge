# Signal Forge — working draft

## Agreed scope

Build the RAGtag-style tracker described in `ragtag-system-analysis.md`, on the local
`ts-boilerplate`. Keep all six feeds: API Models, Arena, News, Web/Claude,
Leaderboards and OpenRouter. Add a seventh GitHub feed.

Deliver through a Telegram bot to ordinary chats or individual forum topics, and
through a Discord bot to selected server channels. Each destination selects its feeds.

Codex is the first **GitHub repository**, not a restriction on the rest of the tracker.
The audience particularly cares about Codex. Telegram is configured; provider keys are still absent.

## Implemented

- Bun/TypeScript, Hono, Zod, SQLite, supervised polling and delivery, Docker files.
- OpenRouter catalog, OpenAI news RSS, Arena roster, Arena leaderboard membership.
- Claude public entry bundle and direct imports: extract defaultMessage strings without
  executing downloaded code; save source evidence and show bounded string-diff excerpts.
- OpenAI, Anthropic and Gemini model catalogs, enabled by their respective API keys.
- GitHub: openai/codex stable releases and commits in selected paths. Ignore prereleases,
  lockfiles and generated files for notifications. Bounded excerpts, links to original
  commits, oldest-first catch-up in batches of ten. No generated AI summary yet.
- Codex official documentation: discover Markdown pages from the official index, retain raw
  evidence, notify paragraph additions/removals. The shared docs index currently has 148 pages.
- Codex PRs: repository OWNER/MEMBER/COLLABORATOR authors, selected paths, bounded diffs;
  distinguish proposals, merged code and releases. Timestamp/comment-only edits are silent.
- Group changes per source/poll; routine catalog metadata and Claude strings form hourly digests.
  Batch membership and targets persist transactionally; old deliveries migrate with IDs intact.
- Quiet baseline, before/after event history, two-observation removal confirmation.
- Transactional event creation and delivery jobs; independent destinations; message splitting;
  429 backoff; unknown send outcomes stop automatic retries to avoid duplicates.
- Read-only HTTP/MCP and CLI status, event history and delivery inspection.

## Verification

- Live source checks: OpenRouter 428 models; Arena 1,055 records; leaderboards 825 entries;
  OpenAI RSS 1,173 items; Claude 3,845 extracted strings; Codex commits and releases retrieved.
  Counts are observations from September 7, 2026, not configured expectations.
- 50 passing tests plus lint, typecheck and production build. Migration checked on a copy of the live database.
- Unit/integration checks cover diff, deduplication, rollback, delivery routing, response
  failures, pagination, source validation, bounded GitHub excerpts and authenticated HTTP/MCP.
- Telegram live delivery verified to the owner: message ID 2 via the durable queue.
- Reused Solo Publisher Discord bot credential and verified its identity and server access.
  Discord use is explicitly deferred; keyed model APIs still need credentials.
- OrbStack: image built, container ran as UID 1000, readiness passed, SIGTERM exited 0.

## Next

- Refine the experience in Telegram first. Discord bot credentials are ready, but channel creation
  and delivery are explicitly deferred by the owner. Telegram personal destination is configured.
- Add DesignArena registry and Bedrock regional catalogs as separate sources.
- Extend Claude coverage beyond the public entry's direct imports; preserve evidence and
  distinguish interface hints from confirmed features. Add optional AI summaries only after
  choosing a model and a spending limit.
- Refine message presentation and noise filtering using actual events seen by the audience.
- Add provider API credentials when supplied; a GitHub token raises the public request allowance.

## Decisions and limits

- No LLM calls are needed to detect catalog changes, RSS posts or commits.
- Arena/Claude page formats are undocumented and can change; parsing failures leave the last
  good state intact and appear in status.
- Leaderboards notify newly observed membership, not every rank/score movement.
- GitHub path filtering is mechanical relevance, not a claim that every matched change matters.
- Public GitHub endpoints work without a token, subject to their low unauthenticated rate limit.
- Production is VM106, `/opt/signal-forge`, localhost:18081. Deploy through `scripts/deploy.sh`.
  Local OrbStack container removed. All 14 previous sent deliveries preserved at cutover.
  VM106 control message delivered through the queue: Telegram message ID 16.
  Copy uses prices per million tokens, changed-parameter lists and Moscow timestamps.
  No Discord messages sent; Discord is deferred until the Telegram experience is refined.
