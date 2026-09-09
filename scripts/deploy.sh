#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run check
# /opt/signal-forge is owned by alex on vm106; credentials never enter the image.
COPYFILE_DISABLE=1 tar -czf - Dockerfile compose.yaml package.json bun.lock tsconfig.json src scripts/backup.sh scripts/backfill-leaderboards.ts scripts/copy-migrations.ts signal-forge.example.json .dockerignore |
  ssh vm106 'cd /opt/signal-forge && rm -rf src && tar -xzf -'
scp -q .env signal-forge.json vm106:/opt/signal-forge/
ssh vm106 'cd /opt/signal-forge && chmod 600 .env signal-forge.json && docker compose stop app && docker compose build app && docker compose run --rm --no-deps app bun dist/scripts/backfill-leaderboards.js && docker compose up -d --wait --wait-timeout 180'
