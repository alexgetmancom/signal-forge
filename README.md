# Signal Forge

One shared Telegram feed with source headings and topic hashtags. Source and stream remain
separate in the database. Outstanding work is in [WORKING-NOTES.md](WORKING-NOTES.md).

## Production

One instance runs on `vm106` in `/opt/signal-forge`. SQLite is in `data/app.db`.
HTTP reports are available on the home LAN at `http://192.168.10.106:18081`; operational APIs still require the bearer token. Do not start a second production collector.

Local `.env` and `signal-forge.json` are the deployment configuration. Deploy through:

```sh
./scripts/deploy.sh
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js status'
ssh vm106 'cd /opt/signal-forge && docker compose logs --tail 50 app'
ssh vm106 'curl -fsS http://192.168.10.106:18081/readyz'
```

Deployment runs checks, builds on VM106 and waits for container health. It preserves the server
database. Credentials are excluded from the image. The container runs as UID 1000 and restarts
automatically.

## Backups

`signal-forge-backup.timer` on VM106 runs `scripts/backup.sh` nightly at 04:20 MSK. It copies the
database with `VACUUM INTO` — SQLite's own online copy, safe while the collector writes and complete
without the `-wal` sidecar — gzips it into `backups/`, reads it back to check `integrity_check` and
the event count, and keeps the last 14. A backup that fails verification fails the unit.

```sh
ssh vm106 'systemctl list-timers signal-forge-backup.timer'
ssh vm106 'sudo systemctl start signal-forge-backup.service && ls -1t /opt/signal-forge/backups | head -3'
```

Restore into a stopped service, never over a live database:

```sh
ssh vm106 'cd /opt/signal-forge && docker compose down'
ssh vm106 'cd /opt/signal-forge && gunzip -c backups/app-<stamp>.db.gz > data/app.db && rm -f data/app.db-wal data/app.db-shm'
ssh vm106 'cd /opt/signal-forge && docker compose up -d --wait'
```

## Configuration

Set `TELEGRAM_BOT_TOKEN` in `.env`. Configure one destination in `signal-forge.json`:

```json
{
  "pollSeconds": 300,
  "destinations": [
    {
      "id": "telegram-feed",
      "platform": "telegram",
      "chatId": "-1001234567890",
      "streams": ["api-models", "openrouter", "news", "arena", "leaderboards", "web", "github"]
    }
  ]
}
```

Replace the example chat ID with the actual destination. Give the bot permission to post;
for personal delivery, start it first. Deploy after configuration changes.

Discord destinations take a `channelId` and the same `streams`. A bot only reaches a private
category when its role is granted `VIEW_CHANNEL` there; creating channels additionally needs
`MANAGE_CHANNELS`, which the bot does not have and does not need for delivery. Verify a new channel
with one manual `POST /channels/<id>/messages` before relying on it — a destination that cannot be
written to only shows up as a failed delivery later.
Destinations receive future events only. The first source observation is quiet.

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` to enable their catalogs.
Set `REPORT_BASE_URL` to the LAN origin used for full web-diff links.
Set `GITHUB_TOKEN` to raise the GitHub request allowance. Optional `github` entries accept
`repo` and `paths`; the default repository is `openai/codex`.

## Inspect delivery problems

Source errors appear in `status`; HTTP readiness does not imply all sources are healthy.
Inspect delivery outcomes with:

```sh
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js deliveries'
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js event 1'
```

Successful sends are never retried. HTTP 429 honors retry timing. Uncertain sends are marked
`ambiguous` and never automatically repeated; inspect the actual chat before considering a resend.
Full event evidence remains in the database even when a message excerpt is truncated.

For HTTP/MCP access, set `MCP_TOKEN` to at least 32 random characters and use
`Authorization: Bearer <token>` with `/api/status`, `/api/events`, `/api/events/:id` or `/api/mcp`.
Read-only MCP tools: `status`, `events`, `event`, `deliveries`.

## Local development

Use a separate development database and destination configuration.

```sh
bun install --frozen-lockfile
```

On a fresh checkout, create `.env` and `signal-forge.json` from their example files.
Do not overwrite the deployment configuration in an existing checkout.

```sh
bun run dev
bun run check
```

`bun run poll` collects once without sending the queue. Stop the development server before
using it; run only one collector per database.
