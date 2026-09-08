# Signal Forge

Source monitoring with persistent change history and Telegram/Discord bot delivery.
Built from `ts-boilerplate` with Bun, TypeScript, Hono, Zod and SQLite.

## Run

```sh
bun install --frozen-lockfile
cp .env.example .env
cp signal-forge.example.json signal-forge.json
bun run dev
```

No credentials are needed to collect OpenRouter, OpenAI news, Arena, leaderboards,
Claude public strings, official Codex documentation and the public Codex repository. The first observation establishes
baseline state without posting old content. With no destinations configured, collection
and history work without sending messages.

```sh
bun run check
bun run status
bun run events
bun src/cli.ts event 1
bun src/cli.ts deliveries
```

`bun run poll` collects immediately without starting a server or sending the queue.
Run only one collecting process against a database; stop the server before a manual poll.
The service runs continuously while its process/container is running.

## Connect destinations

Set `TELEGRAM_BOT_TOKEN` and/or `DISCORD_BOT_TOKEN` in `.env`. Add recipients to
`signal-forge.json`, then restart. IDs are strings to preserve their exact values.

```json
{
  "pollSeconds": 300,
  "destinations": [
    {
      "id": "telegram-models",
      "platform": "telegram",
      "chatId": "-1001234567890",
      "topicId": 42,
      "streams": ["api-models", "openrouter"]
    },
    {
      "id": "discord-codex",
      "platform": "discord",
      "channelId": "123456789012345678",
      "streams": ["github"]
    }
  ]
}
```

Omit `topicId` for a normal Telegram chat. Add the bot to the group/forum with permission
to send messages in the destination topic. For a personal chat, start the bot first.
Discord requires the bot to be installed on the server with View Channel and Send Messages
permissions for each destination. No webhook URL or Gateway connection is required for sending.
Discord mentions are disabled; Telegram messages use plain text.

Streams: `api-models`, `openrouter`, `news`, `arena`, `leaderboards`, `web`, `github`.
One physical destination has one configuration entry; combine streams in that entry.
Destinations receive future events only, not historical backfill.

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` to enable their model
catalogs. These report models visible to those credentials, not universal availability.
Set `GITHUB_TOKEN` for a larger GitHub request allowance. GitHub is checked every 30 minutes,
news every 15 minutes, leaderboards every 30 minutes, and Claude strings and Codex documentation hourly.

The optional `github` array in the JSON config accepts `repo` and `paths`. It defaults to
`openai/codex` and its docs, model catalog, configuration, tools and protocol paths.
Commits are bounded excerpts, not AI interpretations. Stable releases include release notes;
prereleases do not notify. PRs from OWNER/MEMBER/COLLABORATOR authors use the same path filter.
Open/draft PRs, merged code and published releases have separate labels. Repository membership
is an association check, not a guarantee of reliability. Comments and timestamp-only PR updates
are silent. Catch-up processes at most five changed PRs per poll; a busy repository can lag.
Full GitHub content stays linked from each message.

Important events are grouped by source and collection. New/removed models, price, context and
capability changes are immediate. Other model metadata changes and Claude interface strings
accumulate in an hourly digest. Long batches split at platform limits. Each item links its
source and evidence ID; excerpts are capped at 800 characters, with full evidence in storage.
Codex pages are discovered from the official documentation index (currently redirected to
learn.chatgpt.com); the index includes shared ChatGPT/Codex guides. Raw Markdown is retained;
paragraph differences ignore whitespace and the generated index notice.

## Inspect and operate

Set a random `MCP_TOKEN` of at least 32 characters to open authenticated `/api/status`,
`/api/events`, `/api/events/:id` and `/api/mcp`. Send `Authorization: Bearer <token>`.
The MCP endpoint supports initialize, tools/list and tools/call; the read-only tools are
`status`, `events`, `event` and `deliveries`. Liveness `/healthz` and readiness `/readyz`
are public; source failures are reported separately in status.

Events and delivery jobs commit together. Successful sends are never retried. HTTP 429
honors retry timing. Timeouts, invalid success responses, server errors and sends interrupted
by process exit are ambiguous and never automatically repeated. Inspect the actual chat
before deciding whether a resend is appropriate. There is no unattended ambiguous retry.

Snapshots referenced by events are retained; otherwise only the two latest observations per
source remain. Identical raw snapshots are reused. Back up the data directory while stopped.

## Production: VM106

One instance runs in `/opt/signal-forge` on `vm106`, with SQLite in `data/app.db`.
The local OrbStack instance was removed at cutover. Do not start a second production collector.
Deploy from this checkout (local `.env` and `signal-forge.json` are the deployment configuration):

```sh
./scripts/deploy.sh
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js status'
ssh vm106 'cd /opt/signal-forge && docker compose logs --tail 50 app'
ssh vm106 'curl -fsS http://127.0.0.1:18081/readyz'
```

The deploy command checks the code, builds natively on VM106, updates the container and waits
for health. It preserves the server database. Credentials are copied over SSH with mode 600,
excluded from the image. The container runs as UID 1000, restarts automatically, and binds
HTTP only to `127.0.0.1:18081`. Telegram is the only configured destination.

Scope, remaining work and verification are in [WORKING-NOTES.md](WORKING-NOTES.md).
