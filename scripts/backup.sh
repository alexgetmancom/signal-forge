#!/usr/bin/env bash
# Nightly SQLite backup. VACUUM INTO is SQLite's own online copy: it is safe while the
# collector writes, it folds the WAL in, and it produces a compact file rather than a
# snapshot that needs the -wal sidecar to be readable.
#
# Installed on vm106 as /opt/signal-forge/scripts/backup.sh and run by
# signal-forge-backup.timer. Restoring is documented in README.
set -euo pipefail

DIR=${SIGNAL_FORGE_DIR:-/opt/signal-forge}
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
mv "$DIR/data/backup-$STAMP.db" "$DEST/app-$STAMP.db"
gzip -f "$DEST/app-$STAMP.db"

# A backup that cannot be opened is not a backup: read it back before trusting it.
"${RUN[@]}" bun -e "
  const { Database } = require('bun:sqlite');
  const { gunzipSync } = require('node:zlib');
  const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
  writeFileSync('/tmp/verify.db', gunzipSync(readFileSync('/app/backups/app-$STAMP.db.gz')));
  const db = new Database('/tmp/verify.db', { readonly: true });
  const integrity = db.query('PRAGMA integrity_check').get();
  const events = db.query('SELECT COUNT(*) AS n FROM events').get();
  db.close();
  unlinkSync('/tmp/verify.db');
  if (integrity.integrity_check !== 'ok') throw new Error('integrity_check: ' + integrity.integrity_check);
  console.log('verified', '$STAMP', 'events=' + events.n);
"

ls -1t "$DEST"/app-*.db.gz | tail -n "+$((KEEP + 1))" | xargs -r rm --
echo "backup ok: $DEST/app-$STAMP.db.gz"
