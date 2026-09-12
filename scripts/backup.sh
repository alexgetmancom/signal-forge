#!/usr/bin/env bash
# Nightly SQLite backup. VACUUM INTO is SQLite's own online copy: it is safe while the
# collector writes, it folds the WAL in, and it produces a compact file rather than a
# snapshot that needs the -wal sidecar to be readable.
#
# Install and schedule this script from the private deployment environment. Restoring is documented
# in the operator runbook.
set -euo pipefail

: "${SIGNAL_FORGE_DIR:?Set SIGNAL_FORGE_DIR in the backup service environment}"
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
  // exactly like one that ran last night, right up until somebody needs it.
  require('fs').writeFileSync('/app/backups/last-verified.json', JSON.stringify({
    verifiedAt: new Date().toISOString(),
    file: 'app-$STAMP.db.gz',
    bytes: require('fs').statSync('/app/data/backup-$STAMP.db').size,
    events: events.n,
  }) + '\n');
"

mv "$DIR/data/backup-$STAMP.db" "$DEST/app-$STAMP.db"
# pigz is gzip across every core. On this host it compresses the database in 3.8s where gzip takes
# 13.4s, for an archive of the same size and the same format -- `gzip -dc` and the restore path do
# not know the difference. gzip stays as the fallback so the job still runs on a host without it.
COMPRESS=$(command -v pigz || command -v gzip)
"$COMPRESS" -f "$DEST/app-$STAMP.db"
# The archive is the artifact that gets kept, so its own integrity is checked as a stream.
"$COMPRESS" -t "$DEST/app-$STAMP.db.gz"

ls -1t "$DEST"/app-*.db.gz | tail -n "+$((KEEP + 1))" | xargs -r rm --
echo "backup ok: $STAMP"
