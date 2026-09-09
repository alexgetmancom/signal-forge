# Signal Forge operator runbook

This file contains deployment details for the single production instance. It is intentionally kept
out of the public-facing README.

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

## Delivery and health checks

```sh
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js issues'
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js signal-quality 7'
ssh vm106 'cd /opt/signal-forge && docker compose exec -T app bun dist/src/cli.js deliveries-needing-verification'
```

Successful sends are never retried. HTTP 429 honors retry timing. An uncertain send is marked
`ambiguous` and never automatically repeated; inspect the actual destination before reconciliation.
