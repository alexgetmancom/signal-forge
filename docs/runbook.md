# Signal Forge operator runbook

This runbook describes the operational contract without naming the deployment host, address or
filesystem layout. Those values belong in the operator's deployment environment, never in the
repository or a public report.

## Deploy and health

Run deployment from an authorized operator checkout:

```sh
./scripts/deploy.sh
```

The deployment script runs the full check, builds the image, applies migrations, performs the Arena
metadata backfill while the collector is stopped, and waits for container health. It preserves the
production database. Credentials stay in the deployment environment and never enter the image.

After deployment, verify the health endpoint, readiness endpoint, application logs and:

```sh
bun dist/src/cli.js issues
bun dist/src/cli.js signal-quality 7
bun dist/src/cli.js deliveries-needing-verification
```

Run only one collector against a production database. Operational APIs require the configured
bearer token.

## Backups

The scheduled backup runs `scripts/backup.sh` with a separate memory budget. It uses SQLite's
`VACUUM INTO`, compresses the copy, reads it back, runs `PRAGMA integrity_check`, verifies the event
count, and retains the configured number of recent archives. A failed verification must fail the
backup job rather than produce a trusted-looking archive.

## Restore

Restore only while the service is stopped:

1. Stop the application.
2. Decompress the selected archive into the configured database directory.
3. Remove stale `-wal` and `-shm` sidecars.
4. Start the application and wait for readiness.
5. Run `issues`, `signal-quality 7` and the delivery verification report.
6. Run a separate integrity check and compare the restored event count with the backup log.

Do not restore over a live SQLite database.

## Delivery

Successful sends are never retried. HTTP 429 honors retry timing. An uncertain send is marked
`ambiguous` and never automatically repeated; inspect the actual destination before requiring manual
verification.
