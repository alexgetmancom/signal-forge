#!/usr/bin/env bash
# SQLite backup, in two phases so a deployment does not have to wait for the slow one.
#
#   snapshot  VACUUM INTO, read the copy back, record it. Leaves an uncompressed, verified
#             database in backups/ and prints its path. This is what a deployment holds as its
#             rollback point, and it costs about three seconds.
#   archive   Compress every uncompressed snapshot present, check the archive as a stream, rotate.
#             This is the slow half, and nothing waits behind it.
#   all       Both, in order. The nightly job wants this and is unchanged by the split.
#
# Taking the phases apart is what lets scripts/deploy.sh keep its guarantee -- a verified backup
# exists before production is touched -- while paying for compression after the new release is
# already serving. An uncompressed snapshot left by an interrupted run is not a special case to
# clean up: the next archive phase finds it by the same glob and compresses it like any other.
#
# Install and schedule this script from the private deployment environment. Restoring is documented
# in the operator runbook.
set -euo pipefail

: "${SIGNAL_FORGE_DIR:?Set SIGNAL_FORGE_DIR in the backup service environment}"
MODE=${1:-all}
case "$MODE" in
  snapshot | archive | all) ;;
  *)
    echo "usage: backup.sh [snapshot|archive|all]" >&2
    exit 1
    ;;
esac

DIR=$SIGNAL_FORGE_DIR
KEEP=${SIGNAL_FORGE_BACKUP_KEEP:-14}
MEMORY=${SIGNAL_FORGE_BACKUP_MEMORY:-2g}
IMAGE=${SIGNAL_FORGE_BACKUP_IMAGE:-signal-forge:latest}
DEST="$DIR/backups"
STAMP=$(date +%Y%m%d-%H%M%S)

# VACUUM INTO and verification both materialize SQLite pages. The application limit is deliberately
# lower; the backup job gets its own explicit budget so a large database does not die at the limit.
RUN=(docker run --rm --network none --memory "$MEMORY" -v "$DIR/data:/app/data" -v "$DEST:/app/backups" "$IMAGE")

mkdir -p "$DEST"
cd "$DIR"

snapshot() {
  # A one-off container rather than `exec`: `exec` needs the service running, so a backup taken
  # while the collector is stopped for a migration — the moment a backup matters most — did nothing.
  "${RUN[@]}" bun -e "
    const { Database } = require('bun:sqlite');
    const db = new Database('/app/data/app.db', { readonly: true });
    db.exec(\"VACUUM INTO '/app/data/backup-$STAMP.db'\");
    db.close();
  "
  # A backup that cannot be opened is not a backup: read it back before trusting it. The file is
  # verified while it is still uncompressed, because decompressing it in memory to check it needs as
  # much memory as the database is large. That is what killed this job once the database passed a
  # gigabyte: the backup was written, and the step that proves it readable was OOM-killed.
  "${RUN[@]}" bun -e "
    const { Database } = require('bun:sqlite');
    const db = new Database('/app/data/backup-$STAMP.db', { readonly: true });
    const integrity = db.query('PRAGMA integrity_check').get();
    const events = db.query('SELECT COUNT(*) AS n FROM events').get();
    db.close();
    if (integrity.integrity_check !== 'ok') throw new Error('integrity_check: ' + integrity.integrity_check);
    console.log('verified', '$STAMP', 'events=' + events.n);
    // The service cannot see this job. Without a marker, a backup that stopped three weeks ago looks
    // exactly like one that ran last night, right up until somebody needs it. It names the file that
    // exists at this instant -- the archive phase renames it in the marker once it has one.
    require('fs').writeFileSync('/app/backups/last-verified.json', JSON.stringify({
      verifiedAt: new Date().toISOString(),
      file: 'app-$STAMP.db',
      bytes: require('fs').statSync('/app/data/backup-$STAMP.db').size,
      events: events.n,
    }) + '\n');
  "
  mv "$DIR/data/backup-$STAMP.db" "$DEST/app-$STAMP.db"
  echo "snapshot ready: $DEST/app-$STAMP.db"
}

archive() {
  # pigz is gzip across every core. On this host it compresses the database in 3.8s where gzip takes
  # 13.4s, for an archive of the same size and the same format -- `gzip -dc` and the restore path do
  # not know the difference. gzip stays as the fallback so the job still runs on a host without it.
  local compress
  compress=$(command -v pigz || command -v gzip)
  local snapshot_file archived=""
  # Every uncompressed snapshot, not only this run's: one left behind by a deployment that died
  # between the phases is archived here rather than lingering outside the rotation.
  for snapshot_file in "$DEST"/app-*.db; do
    [[ -f "$snapshot_file" ]] || continue
    "$compress" -f "$snapshot_file"
    # The archive is the artifact that gets kept, so its own integrity is checked as a stream.
    "$compress" -t "$snapshot_file.gz"
    archived=$(basename "$snapshot_file.gz")
    echo "archived: $archived"
  done
  # The marker named the uncompressed snapshot while that was the file that existed. Now that the
  # archive does, it names the archive, and `doctor` reports something a reader can go and find.
  if [[ -n "$archived" && -f "$DEST/last-verified.json" ]]; then
    "${RUN[@]}" bun -e "
      const path = '/app/backups/last-verified.json';
      const marker = JSON.parse(require('fs').readFileSync(path, 'utf8'));
      marker.file = '$archived';
      require('fs').writeFileSync(path, JSON.stringify(marker) + '\n');
    "
  fi
  # Nothing to rotate is the normal state on a host that has just been set up, and under `pipefail`
  # a failing `ls` would turn that into a failed job.
  if compgen -G "$DEST/app-*.db.gz" > /dev/null; then
    ls -1t "$DEST"/app-*.db.gz | tail -n "+$((KEEP + 1))" | xargs -r rm --
  fi
  echo "backup ok: $STAMP"
}

case "$MODE" in
  snapshot) snapshot ;;
  archive) archive ;;
  all)
    snapshot
    archive
    ;;
esac
