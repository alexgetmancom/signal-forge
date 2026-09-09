#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run check
# /opt/signal-forge is owned by alex on vm106; credentials never enter the image.
COPYFILE_DISABLE=1 tar -czf - Dockerfile compose.yaml package.json bun.lock tsconfig.json src scripts/backup.sh scripts/copy-migrations.ts signal-forge.example.json .dockerignore |
  ssh vm106 'cd /opt/signal-forge && rm -rf src && tar -xzf -'
scp -q .env signal-forge.json vm106:/opt/signal-forge/
ssh vm106 'cd /opt/signal-forge && chmod 600 .env signal-forge.json && docker compose up -d --build --wait --wait-timeout 180'
