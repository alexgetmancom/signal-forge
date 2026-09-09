#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run check
DEPLOY_HOST=${SIGNAL_FORGE_DEPLOY_HOST:?Set SIGNAL_FORGE_DEPLOY_HOST in the operator environment}
DEPLOY_DIR=${SIGNAL_FORGE_DEPLOY_DIR:?Set SIGNAL_FORGE_DEPLOY_DIR in the operator environment}
REMOTE_DIR=$(printf '%q' "$DEPLOY_DIR")
COPYFILE_DISABLE=1 tar -czf - Dockerfile compose.yaml package.json bun.lock tsconfig.json src scripts/backup.sh scripts/backfill-leaderboards.ts scripts/copy-migrations.ts scripts/migrate-claude-web.ts signal-forge.example.json .dockerignore |
  ssh "$DEPLOY_HOST" "cd $REMOTE_DIR && rm -rf src && tar -xzf -"
scp -q .env signal-forge.json "$DEPLOY_HOST:$DEPLOY_DIR/"
ssh "$DEPLOY_HOST" "cd $REMOTE_DIR && chmod 600 .env signal-forge.json && docker compose stop app && docker compose build app && docker compose run --rm --no-deps app bun dist/scripts/migrate-claude-web.js && docker compose run --rm --no-deps app bun dist/scripts/backfill-leaderboards.js && docker compose up -d --wait --wait-timeout 180"
