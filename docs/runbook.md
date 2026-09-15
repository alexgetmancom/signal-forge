# Operator runbook

Every procedure here is a script, because a procedure that lives in prose is a procedure nobody
runs the same way twice. What is left in this file is the route — which script, when — and the few
things the scripts cannot know. Hosts, paths and credentials stay in the operator's deployment
environment, never in this repository.

Set `SIGNAL_FORGE_DIR` to the deployment directory for every script below. Deployment additionally
needs `SIGNAL_FORGE_DEPLOY_HOST`, `SIGNAL_FORGE_DEPLOY_DIR` and `SIGNAL_FORGE_BIND_ADDRESS`.

| When | Run |
| --- | --- |
| Ship a release | CI, on push to `main`; `./scripts/deploy.sh` by hand only when CI cannot |
| Nightly | `./scripts/backup.sh` (snapshot, then archive) |
| Before a migration | `bun scripts/rehearse-migration.ts /path/to/app.db` |
| On a schedule, and after any schema or backup change | `./scripts/restore-drill.sh` |
| After losing the database | `./scripts/restore.sh --yes [archive]` |
| To see whether any of it worked | `bun dist/src/cli.js doctor`, `issues`, `status` |

`bun dist/src/cli.js guide` is the command catalogue and the symptom index. Run one collector
against a production database, never two. The operational HTTP API requires its bearer token.

## After a deployment

```sh
bun dist/src/cli.js doctor
bun dist/src/cli.js issues
bun dist/src/cli.js signal-quality 7
bun dist/src/cli.js channel-mix 7
bun dist/src/cli.js deliveries-needing-verification
```

Deployment pulls the image CI built, applies migrations with the collectors stopped, preserves the
database, waits for health and keeps the five most recent release images. It refuses an image that
is not pinned by digest, and says so: a tag can be repointed after the checks ran.

## Migrations

Three things will ruin a migration, and none of them is visible afterwards.

**A copy without its write-ahead log is not the database.** A plain file copy leaves `app.db-wal`
behind, so the newest pages are missing and a rehearsal answers for a database that does not exist:

```sh
sqlite3 /path/to/app.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

**Production is the database on the production host**, not the `data/app.db` in a checkout. That
copy has its own history, and a version stamped on it proves nothing about the one subscribers
depend on. Rehearse against a copy of the real thing: `rehearse-migration.ts` reports schema
versions, per-table row changes, and how many stored `records.body` values the migration moves.

**A subscriber-facing string lives in `records.body` and is compared byte for byte.** A body that
changes without a deliberate rewrite emits a "changed" event for every record carrying it. Migrate
with the collector stopped.

Migrations 001–025 were squashed into `025_baseline.sql` on 2026-09-13; the steps are in the git
log. An archive from before the squash carries a version below 25 and the baseline cannot walk it
forward: check out the commit before the squash, migrate it there, and come back.

## Backups and restore

`backup.sh` runs in two phases so a deployment need not wait for the slow one: `snapshot` makes a
verified copy in about three seconds and is what `deploy.sh` holds as its rollback point; `archive`
compresses and rotates. With no argument it does both, which is what the nightly job wants. The
snapshot also copies `signal-forge.json`, because the routing table exists in exactly one place
otherwise. After a successful verification the job writes `last-verified.json`, which is the only
thing the service can see of a job that runs outside it: `doctor` reads it and `issues` raises
`backup_stale`.

`restore-drill.sh` restores the newest archive into a throwaway instance with no network, checks
integrity and provenance, boots it, rebuilds every derived view and destroys the copy. Expect
`issues` to be long inside the drill: every source fails without a network, and that is the
isolation working.

`restore.sh` is the real thing, and the only script here that destroys production state. It refuses
to run without `--yes`, copies the database it is about to overwrite into `backups/superseded-*.db`,
removes the stale sidecars, checks integrity, boots the application and rebuilds the derived views.

Two decisions stay with the operator. **Whether to restore at all**: a restored database is missing
everything since the archive was taken, and a corrupted one may still be repairable. **What the
delivery queue will do**: a restored database carries the queue as it was, so anything pending at
backup time sends on start and subscribers may see it twice. Read `deliveries` first if that matters
more than the minutes it costs.

## Shadow sources

`sourceEnabled` decides whether a collector runs. A source with `sourceMode` set to `shadow` keeps
snapshots, events, stories and metrics but creates no delivery work. GitHub and Hugging Face
discovery, the Hugging Face blog and OpenRouter usage are shadow by default. Promote one by editing
the operator-owned JSON, never through the CLI, and verify the result in `status`:

```json
{ "sourceMode": { "discovery:github-ai": "active" } }
```

## Discord setup

The only part of delivery that lives outside this repository, because it is configuration in
somebody else's product and nothing here can read it or check it.

A bot reaches a private category only when its role holds `VIEW_CHANNEL` there. Mentioning a role
that is not marked mentionable needs *Mention @everyone, @here and All Roles* in that channel, which
a channel inheriting its category's permissions gets automatically. Verify a new channel with one
manual `POST /channels/<id>/messages` before routing anything to it: a destination that cannot be
written to shows up as a failed delivery hours later, and a 403 on a reader channel looks exactly
like a quiet week.

Destinations, boards, roles and the promotion thresholds are set in `signal-forge.json`; the shape
is in `signal-forge.example.json`, and the service validates it on start. Deploy after changing it.
A new destination receives future events only -- the first observation of a source is a quiet
baseline.

## Delivery

Successful sends are never retried, and HTTP 429 honours the retry timing it is given. An uncertain
outcome is `ambiguous` and is never repeated automatically: inspect the actual channel, then
`require-delivery-verification` and `resolve-delivery-verification` record what happened without
sending a second message.
