# Signal Forge

Six Discord channels, one stream per subject, plus two boards that are edited in place rather than
posted repeatedly. Source and stream remain separate in the database, so a channel layout is a
configuration choice and not a schema. Outstanding work is in [WORKING-NOTES.md](WORKING-NOTES.md).

Telegram delivery is implemented and tested but has no destination configured: the audience is on
Discord. Re-enabling it is one entry in `signal-forge.json`, which is why the code stays.

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

## Boards

Two messages are edited in place instead of being reposted, so a channel holds a state rather than
a log. Both are rewritten only when their content actually changed — editing an unchanged board
would mark the channel unread for everyone watching it. Deleting a board by hand makes the next
cycle post a fresh one, which is also how their order in the channel is fixed.

**Platform health** (`platformBoardChannelId`, defaults to the status channel) shows what OpenAI's
and Anthropic's own status pages say, with their open incidents. Vendors that do not run Statuspage
are absent on purpose: `status.x.ai` refuses its own API, and Google publishes a different document
for the whole cloud.

**Tracker status** (`statusChannelId`) is about us: every collector with a coloured dot, grouped, edited in place every five minutes. It is
rewritten only when something actually changed, so the channel holds a board rather than a log, and
deleting the message by hand makes the next cycle post a fresh one.

A blocked source is not a broken one. `gemini` answers everywhere except the addresses this project
can reach, so it shows as restricted with its cause instead of counting against the headline — a
board that calls every silence an outage teaches people to ignore it.

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

## Alerts

`alertChannelId` names a private channel that receives one message when a collector stops
reporting and one when it recovers — never a repeat while the same outage continues. This is
operational noise for the owner, not content for subscribers, so it does not go to a feed channel.
A rejected alert leaves the stored state untouched, so the next cycle retries rather than losing
the transition.

## Configuration

Set `DISCORD_BOT_TOKEN` in `.env`. Configure destinations in `signal-forge.json`:

```json
{
  "pollSeconds": 300,
  "destinations": [
    {
      "id": "discord-api-models",
      "platform": "discord",
      "channelId": "000000000000000000",
      "streams": ["api-models", "openrouter", "weights"]
    }
  ],
  "statusChannelId": "000000000000000000",
  "alertChannelId": "000000000000000000",
  "vendorRoles": { "OpenAI": "000000000000000000" }
}
```

Replace the example IDs with the actual ones. Deploy after configuration changes.

`vendorRoles` maps a vendor, as `vendorOf()` resolves it, to the role that follows that vendor. A
role is pinged only when a model appears or disappears — a price edit travels in the same message
without waking anyone — and never from a digest. The permitted mention list names exactly the roles
the message mentions, so a stray ID cannot ping. Mentioning a role that is not "mentionable"
requires the bot to hold *Mention @everyone, @here and All Roles* in that channel; a channel that
still inherits its category's permissions gets this automatically.

Timestamps: Discord messages carry `<t:unix:f>`, which every reader sees in their own timezone;
Telegram has no such markup and gets a fixed UTC stamp built without `Intl`, because the runtime's
ICU data disagrees with itself about whether `short` is "Sep" or "Sept".

Discord destinations take a `channelId` and the same `streams`. A bot only reaches a private
category when its role is granted `VIEW_CHANNEL` there; creating channels additionally needs
`MANAGE_CHANNELS`, which the bot does not have and does not need for delivery. Verify a new channel
with one manual `POST /channels/<id>/messages` before relying on it — a destination that cannot be
written to only shows up as a failed delivery later.
Destinations receive future events only. The first source observation is quiet.

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` to enable their catalogs.
Set `REPORT_BASE_URL` to the LAN origin used for full web-diff links.
Set `GITHUB_TOKEN` to raise the GitHub request allowance from 60 to 5000 an hour. Listing requests
are conditional, and a 304 costs no quota at all. Optional `github` entries accept
`repo` and `paths`; the default repository is `openai/codex`.

## Request footprint

Observations are conditional wherever a server offers a validator: `http_cache` stores the body
with its `ETag`, and an unchanged page answers 304 with no body. Assets served `immutable` — the
Claude bundle, whose filenames carry a content hash — are not requested again at all, which took
one observation from 608 requests and 21 MB to 2 requests and 0.1 MB. A body arriving without a
validator is deliberately not stored, since the next observation must download it regardless.

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
