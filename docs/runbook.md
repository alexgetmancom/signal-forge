# Signal Forge operator runbook

This runbook describes the operational contract without naming the deployment host, address or
filesystem layout. Those values belong in the operator's deployment environment, never in the
repository or a public report.

## Deploy and health

Run deployment from an authorized operator checkout:

```sh
./scripts/deploy.sh
```

Set `SIGNAL_FORGE_DEPLOY_HOST`, `SIGNAL_FORGE_DEPLOY_DIR` and `SIGNAL_FORGE_BIND_ADDRESS` in the
operator environment before deployment. Keep their values outside the repository.

The release image is built and checked once in CI and published to the private container registry.
Deployment pulls it by digest through `DEPLOY_IMAGE`, which the script requires and refuses unless
it is pinned by digest: a tag can be repointed after the checks ran. Production no longer compiles
anything.

The deployment script pulls the image, applies migrations, normalizes Claude Web evidence and
performs the Arena metadata backfill while the collectors are stopped, then waits for container
health. It preserves the production database. Credentials stay in the deployment environment and
never enter the image. Afterwards it keeps the five most recent release images and removes older
ones; set `SIGNAL_FORGE_KEEP_RELEASES` to keep a different number.

After deployment, verify the health endpoint, readiness endpoint, application logs and:

```sh
bun dist/src/cli.js guide
bun dist/src/cli.js doctor
bun dist/src/cli.js issues
bun dist/src/cli.js signal-quality 7
bun dist/src/cli.js code-analytics 7
bun dist/src/cli.js deepseek-usage 30
bun dist/src/cli.js models
bun dist/src/cli.js hypotheses
bun dist/src/cli.js lifecycle-deadlines
bun dist/src/cli.js deliveries-needing-verification
```

Run only one collector against a production database. Operational APIs require the configured
bearer token.

### Shadow sources

`sourceEnabled` decides whether a collector runs. A running source with `sourceMode` set to
`shadow` persists snapshots and immutable events and participates in stories, projections and
metrics, but cannot create subscriber delivery work. GitHub and Hugging Face discovery are shadow
by default. Promote a source by editing the operator-owned JSON configuration:

```json
{
  "sourceMode": {
    "discovery:github-ai": "active"
  }
}
```

Do not edit configuration through the CLI. Verify the resulting source mode in `status` before
enabling a discovery source for subscribers.

The intelligence projections are derived from immutable evidence: Model Facts retain event or
current-observation provenance, hypotheses are interpretations rather than evidence, and lifecycle
reminders are derived delivery work rather than synthetic events. Attention scores are triage
values and never change confidence, which remains source-derived.

## Backups

The scheduled backup runs `scripts/backup.sh` with `SIGNAL_FORGE_DIR` set to the private deployment
directory and a separate memory budget. It uses SQLite's
`VACUUM INTO`, compresses the copy, reads it back, runs `PRAGMA integrity_check`, verifies the event
count, and retains the configured number of recent archives. A failed verification must fail the
backup job rather than produce a trusted-looking archive.

After a successful verification the job writes `last-verified.json` into the backup directory. That
marker is the only thing the service can see of a job that runs outside it: `doctor` reads it, and
`issues` raises `backup_stale` when the newest verified archive is more than two nights old. A
backup directory with archives and no marker is reported as unverified, because an archive nobody
read back is a file, not a backup.

## Migrations

Rehearse on a copy of the database the migration will actually run against:

```sh
bun scripts/rehearse-migration.ts /path/to/app.db
```

It reports the schema versions, per-table row changes and — the case that matters here — how many
stored `records.body` values the migration moved. A subscriber-facing string lives in those bodies
and is compared byte for byte, so a body that changed without a deliberate rewrite is a "changed"
event for every record carrying it. Migrate with the collector stopped.

## Restore

Restore only while the service is stopped:

1. Stop the application.
2. Decompress the selected archive into the configured database directory.
3. Remove stale `-wal` and `-shm` sidecars.
4. Start the application and wait for readiness.
5. Run `issues`, `signal-quality 7` and the delivery verification report.
6. Run a separate integrity check and compare the restored event count with the backup log.
7. Run `models`, `hypotheses` and `lifecycle-deadlines` to confirm the derived views rebuild consistently.

Do not restore over a live SQLite database.

### Drill

`./scripts/restore-drill.sh [archive]` performs the whole procedure against a throwaway copy and
destroys it afterwards. It defaults to the newest archive. Run it on a schedule that matches how
much loss would be tolerable, and after any change to the schema or the backup job.

The drill instance runs with no network at all. A restored database carries the delivery queue as it
was, so an instance that could reach Discord would re-send messages subscribers already have;
`--network none` makes that impossible rather than unlikely, and no credentials are passed either.
Every source therefore fails inside the drill and `issues` is long — that is the isolation working.

It fails, rather than reporting success, when the archive will not decompress, when
`integrity_check` or `foreign_key_check` object, when any event has lost its snapshot, when the
application does not become ready, when a derived view will not rebuild, or when the archive holds
more events than production does.

## Delivery

Successful sends are never retried. HTTP 429 honors retry timing. An uncertain send is marked
`ambiguous` and never automatically repeated; inspect the actual destination, require manual
verification, then record the final outcome without sending again.
