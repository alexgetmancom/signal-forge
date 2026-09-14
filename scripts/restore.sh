#!/usr/bin/env bash
# Put a backup back, on the database subscribers depend on.
#
# The drill proves an archive can come back; this is the thing itself, and it is the only script
# here that destroys production state. So it does the two things a person doing this by hand at
# three in the morning forgets: it takes a snapshot of what it is about to overwrite -- a restore
# onto the wrong database is otherwise unrecoverable -- and it removes the stale `-wal` and `-shm`
# sidecars, which SQLite would happily recover onto the restored file and hand back a state nobody
# asked for.
#
# It refuses to run without an explicit yes, because no flag ordering should be able to wipe a
# database by accident.
#
#   ./scripts/restore.sh --yes [archive]
#
# A restored database carries the delivery queue exactly as it was at backup time. Anything that was
# pending then will send when the application starts, and subscribers may see it twice. Read
# `deliveries` before starting if that matters more than the minutes it costs.
set -euo pipefail

CONFIRMED=0
ARCHIVE=""
for argument in "$@"; do
  case "$argument" in
    --yes) CONFIRMED=1 ;;
    -*)
      echo "usage: restore.sh --yes [archive]" >&2
      exit 1
      ;;
    *) ARCHIVE=$argument ;;
  esac
done

: "${SIGNAL_FORGE_DIR:?Set SIGNAL_FORGE_DIR to the deployment directory}"
DIR=$SIGNAL_FORGE_DIR
IMAGE=${SIGNAL_FORGE_RESTORE_IMAGE:-signal-forge:latest}
MEMORY=${SIGNAL_FORGE_RESTORE_MEMORY:-2g}
COMPOSE_FILE="$DIR/compose.yaml"
ARCHIVE=${ARCHIVE:-$(ls -1t "$DIR"/backups/app-*.db.gz 2>/dev/null | head -1)}
STAMP=$(date -u +%Y%m%d-%H%M%S)

[[ -f "$COMPOSE_FILE" ]] || { echo "No compose file at $COMPOSE_FILE" >&2; exit 1; }
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "No archive to restore from" >&2; exit 1; }

compose() { docker compose --project-directory "$DIR" -f "$COMPOSE_FILE" "$@"; }
run() { docker run --rm --network none --memory "$MEMORY" -v "$DIR/data:/app/data" "$IMAGE" "$@"; }
step() { printf '\n== %s\n' "$1"; }

step "About to overwrite production"
echo "archive:  $ARCHIVE"
ls -lh "$ARCHIVE" | awk '{print "size:     " $5, $6, $7, $8}'
echo "database: $DIR/data/app.db"
if (( CONFIRMED == 0 )); then
  echo
  echo "Nothing was changed. Re-run with --yes once the archive above is the one you mean." >&2
  exit 1
fi

step "Archive integrity"
gzip -t "$ARCHIVE"
echo "gzip stream ok"

step "Stopping the application"
compose down --remove-orphans

# The database being replaced may be the only copy of the hours since the last backup, and it is
# about to stop existing. This costs seconds and is the difference between a bad restore and a lost
# week.
step "Keeping what is there now"
if [[ -f "$DIR/data/app.db" ]]; then
  SUPERSEDED="$DIR/backups/superseded-$STAMP.db"
  cp "$DIR/data/app.db" "$SUPERSEDED"
  [[ -f "$DIR/data/app.db-wal" ]] && cp "$DIR/data/app.db-wal" "$SUPERSEDED-wal"
  [[ -f "$DIR/data/app.db-shm" ]] && cp "$DIR/data/app.db-shm" "$SUPERSEDED-shm"
  echo "$SUPERSEDED"
else
  echo "no database in place; restoring onto an empty directory"
fi

step "Restoring"
gzip -dc "$ARCHIVE" >"$DIR/data/app.db.restoring"
mv "$DIR/data/app.db.restoring" "$DIR/data/app.db"
# Sidecars belong to the database that was just replaced.
rm -f "$DIR/data/app.db-wal" "$DIR/data/app.db-shm"
ls -lh "$DIR/data/app.db" | awk '{print "restored: " $5}'

step "Integrity and counts"
# Captured rather than streamed, so an empty result is a failure instead of a blank line.
CHECKS=$(run bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('/app/data/app.db', { readonly: true });
  const integrity = db.query('PRAGMA integrity_check').get().integrity_check;
  const foreign = db.query('PRAGMA foreign_key_check').all().length;
  const count = (table) => db.query('SELECT COUNT(*) AS n FROM ' + table).get().n;
  const orphans = db.query(
    'SELECT COUNT(*) AS n FROM events e LEFT JOIN snapshots s ON s.id=e.snapshot_id WHERE s.id IS NULL'
  ).get().n;
  const lines = ['events','snapshots','stories','deliveries','suppressions'].map((t) => t + '=' + count(t));
  db.close();
  if (integrity !== 'ok') throw new Error('integrity_check: ' + integrity);
  if (foreign !== 0) throw new Error('foreign_key_check: ' + foreign + ' violations');
  if (orphans !== 0) throw new Error(orphans + ' events have no snapshot');
  console.log(lines.join(' '));
")
[[ -n "$CHECKS" ]] || { echo "the integrity step produced no output; the restore proves nothing" >&2; exit 1; }
echo "$CHECKS"
echo "integrity=ok foreign_key_violations=0 orphaned_events=0"

step "Starting the application"
compose up -d
for attempt in $(seq 1 120); do
  if compose exec -T app sh -c 'bun -e "
      const response = await fetch(\"http://127.0.0.1:8080/readyz\");
      if (!response.ok) process.exit(1);
      console.log(await response.text());
    "' 2>/dev/null; then
    echo "ready after ${attempt}s"
    break
  fi
  [[ "$attempt" == 120 ]] && { compose logs --tail 40 app; echo "never became ready" >&2; exit 1; }
  sleep 1
done

step "Derived views rebuild"
# A view that cannot rebuild from the restored database is a failed restore, not a detail.
for command in issues models hypotheses lifecycle-deadlines stories; do
  printf '%s: ' "$command"
  compose exec -T app sh -c "cd /app && bun dist/src/cli.js $command | bun -e \"
    const parsed = JSON.parse(await Bun.stdin.text());
    const rows = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    console.log(rows + (Array.isArray(parsed) ? ' rows' : ' fields'));
  \"" || { echo "FAILED: $command did not rebuild" >&2; exit 1; }
done

step "Result"
echo "Restored $ARCHIVE."
echo "The database it replaced is in $DIR/backups/superseded-$STAMP.db until you delete it."
echo "Now read: deliveries-needing-verification, then issues and signal-quality 7."
