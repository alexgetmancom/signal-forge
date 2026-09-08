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
DEST="$DIR/backups"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DEST"
cd "$DIR"

# The container owns the database file, so the copy is made from inside it.
docker compose exec -T app bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('/app/data/app.db', { readonly: true });
  db.exec(\"VACUUM INTO '/app/data/backup-$STAMP.db'\");
  db.close();
"
mv "$DIR/data/backup-$STAMP.db" "$DEST/app-$STAMP.db"
gzip -f "$DEST/app-$STAMP.db"

# A backup that cannot be opened is not a backup: read it back before trusting it.
docker compose exec -T app bun -e "
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
