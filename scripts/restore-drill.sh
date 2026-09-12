#!/usr/bin/env bash
# Prove a backup can actually come back.
#
# A backup that has never been restored is a hypothesis. This restores one into a throwaway
# instance, checks its integrity, boots the application against it and rebuilds every derived view,
# then destroys the copy. It never touches the live database and never writes to the archive.
#
# The drill instance runs with no network at all. That is not caution about the sources: a restored
# database carries the delivery queue as it was, and an instance that could reach Discord would
# re-send messages subscribers already have. `--network none` makes that impossible rather than
# unlikely, which is why no credentials are passed either.
set -euo pipefail

: "${SIGNAL_FORGE_DIR:?Set SIGNAL_FORGE_DIR to the deployment directory}"
DIR=$SIGNAL_FORGE_DIR
IMAGE=${SIGNAL_FORGE_DRILL_IMAGE:-signal-forge:latest}
MEMORY=${SIGNAL_FORGE_DRILL_MEMORY:-2g}
ARCHIVE=${1:-$(ls -1t "$DIR"/backups/app-*.db.gz | head -1)}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/signal-forge-drill.XXXXXX")
NAME="signal-forge-drill-$$"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
run() { docker run --rm --network none --memory "$MEMORY" -v "$WORK:/app/data" "$IMAGE" "$@"; }

step "Archive"
echo "$ARCHIVE"
ls -lh "$ARCHIVE" | awk '{print $5, $6, $7, $8}'

step "Archive integrity"
gzip -t "$ARCHIVE"
echo "gzip stream ok"

step "Restore"
# Step 3 of the runbook: stale sidecars belong to a database that no longer exists. SQLite will
# happily recover a -wal onto a restored file and hand back a state nobody asked for.
gzip -dc "$ARCHIVE" >"$WORK/app.db"
rm -f "$WORK/app.db-wal" "$WORK/app.db-shm"
ls -lh "$WORK/app.db" | awk '{print $5}'

step "Integrity and counts"
# The output is captured rather than streamed so an empty result is an error instead of a blank
# line. A drill that silently skips its own central check is worse than one that fails.
CHECKS=$(run bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('/app/data/app.db', { readonly: true });
  const integrity = db.query('PRAGMA integrity_check').get().integrity_check;
  const foreign = db.query('PRAGMA foreign_key_check').all().length;
  const count = (t) => db.query('SELECT COUNT(*) AS n FROM ' + t).get().n;
  const orphans = db.query(
    'SELECT COUNT(*) AS n FROM events e LEFT JOIN snapshots s ON s.id=e.snapshot_id WHERE s.id IS NULL'
  ).get().n;
  const lines = ['events','snapshots','stories','deliveries','suppressions'].map((t) => t + '=' + count(t));
  db.close();
  if (integrity !== 'ok') throw new Error('integrity_check: ' + integrity);
  if (foreign !== 0) throw new Error('foreign_key_check: ' + foreign + ' violations');
  if (orphans !== 0) throw new Error(orphans + ' events have no snapshot');
  console.log(lines.join(' '));
  console.log('integrity=ok foreign_key_violations=0 orphaned_events=0');
")
[ -n "$CHECKS" ] || { echo "the integrity step produced no output; the drill proves nothing"; exit 1; }
echo "$CHECKS"
RESTORED_EVENTS=$(printf '%s' "$CHECKS" | sed -n 's/.*\bevents=\([0-9]*\).*/\1/p' | head -1)

step "Migrations and boot"
# A configuration with no destinations, beside the restored database: the drill proves the schema
# migrates and the views rebuild, not that the copy can deliver. It is written before the container
# starts, because a container that exits on a missing config cannot be exec'd into to create one.
printf '{"pollSeconds":86400,"destinations":[]}' >"$WORK/drill.json"
# Readiness is read from inside the container: with no network there is nothing to curl from here.
docker run -d --name "$NAME" --network none --memory "$MEMORY" \
  -e DATABASE_URL=/app/data/app.db -e CONFIG_PATH=/app/data/drill.json -e PORT=8080 \
  -v "$WORK:/app/data" "$IMAGE" >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$NAME" sh -c 'bun -e "
      const r = await fetch(\"http://127.0.0.1:8080/readyz\");
      if (!r.ok) process.exit(1);
      console.log(await r.text());
    "' 2>/dev/null; then
    echo "ready after ${attempt}s"
    break
  fi
  [ "$attempt" = 60 ] && { docker logs --tail 40 "$NAME"; echo "never became ready"; exit 1; }
  sleep 1
done

step "Derived views rebuild"
# Counted inside the container: the host that runs this drill is not required to have a runtime.
# A view that cannot rebuild from a restored database is a failed restore, so it stops the drill.
#
# Expect `issues` to be long. Every source fails on an instance with no network, and that is the
# isolation working rather than a damaged archive. The numbers worth reading are the other four.
for command in issues models hypotheses deadlines stories; do
  printf '%s: ' "$command"
  docker exec "$NAME" sh -c "cd /app && bun dist/src/cli.js $command | bun -e \"
    const parsed = JSON.parse(await Bun.stdin.text());
    const rows = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    console.log(rows + (Array.isArray(parsed) ? ' rows' : ' fields'));
  \"" || { echo "FAILED: $command did not rebuild from the restored database"; exit 1; }
done

step "Against the live database"
# The restored copy is older than production, so its counts must be lower and never higher. Higher
# would mean the archive came from somewhere else, which is the one result worth stopping for.
if [ -r "$DIR/data/app.db" ]; then
  LIVE=$(docker run --rm --network none --memory "$MEMORY" -v "$DIR/data:/app/live:ro" "$IMAGE" bun -e "
    const { Database } = require('bun:sqlite');
    const db = new Database('/app/live/app.db', { readonly: true });
    console.log(db.query('SELECT COUNT(*) AS n FROM events').get().n);
    db.close();
  ")
  echo "restored=$RESTORED_EVENTS live=$LIVE"
  [ "$RESTORED_EVENTS" -le "$LIVE" ] || { echo "the archive holds more events than production"; exit 1; }
else
  echo "live database not readable from here; skipped"
fi

step "Result"
echo "Restored $ARCHIVE, booted it, rebuilt every derived view, destroyed the copy."
