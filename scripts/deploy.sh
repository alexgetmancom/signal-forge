#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DIR=$(cd "$(dirname "$0")/.." && pwd)
: "${SIGNAL_FORGE_DEPLOY_DIR:?Set SIGNAL_FORGE_DEPLOY_DIR in the runner environment}"
: "${DEPLOY_RELEASE:?Set DEPLOY_RELEASE to the commit SHA}"

if [[ ! "$DEPLOY_RELEASE" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_RELEASE must be a full commit SHA" >&2
  exit 1
fi

DEPLOY_DIR=$SIGNAL_FORGE_DEPLOY_DIR
RELEASE_IMAGE="signal-forge:$DEPLOY_RELEASE"
ROLLBACK_IMAGE="signal-forge:rollback-$DEPLOY_RELEASE"
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
NEXT_COMPOSE="$DEPLOY_DIR/compose.yaml.next"
PREVIOUS_COMPOSE="$DEPLOY_DIR/compose.yaml.previous"
IMAGE_ENV="$DEPLOY_DIR/deploy-image.env"
BACKUP=""
STOPPED=0

for required in "$DEPLOY_DIR/.env" "$DEPLOY_DIR/signal-forge.json" "$DEPLOY_DIR/data" "$DEPLOY_DIR/backups"; do
  if [[ ! -e "$required" ]]; then
    echo "Required production state is missing: $required" >&2
    exit 1
  fi
done

current_container=$(docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" ps -q app)
if [[ -z "$current_container" ]]; then
  echo "The production app container is not running" >&2
  exit 1
fi
current_image_id=$(docker inspect --format '{{.Image}}' "$current_container")
docker tag "$current_image_id" "$ROLLBACK_IMAGE"

rollback() {
  status=$?
  if (( status == 0 )); then
    return
  fi
  trap - EXIT
  echo "Deployment failed; restoring the previous release" >&2
  if (( STOPPED == 1 )); then
    failed_compose=$NEXT_COMPOSE
    if [[ ! -f "$failed_compose" ]]; then
      failed_compose=$COMPOSE_FILE
    fi
    docker compose --project-directory "$DEPLOY_DIR" -f "$failed_compose" down --remove-orphans || true
    if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then
      rm -f "$DEPLOY_DIR/data/app.db" "$DEPLOY_DIR/data/app.db-wal" "$DEPLOY_DIR/data/app.db-shm"
      gzip -dc "$BACKUP" > "$DEPLOY_DIR/data/app.db"
    fi
    if [[ -f "$PREVIOUS_COMPOSE" ]]; then
      mv -f "$PREVIOUS_COMPOSE" "$COMPOSE_FILE"
    fi
    SIGNAL_FORGE_IMAGE=$ROLLBACK_IMAGE docker compose --project-directory "$DEPLOY_DIR" \
      --env-file "$DEPLOY_DIR/.env" -f "$COMPOSE_FILE" up -d --wait --wait-timeout 180 || true
  fi
  rm -f "$NEXT_COMPOSE" "$PREVIOUS_COMPOSE"
  exit "$status"
}
trap rollback EXIT

docker build --pull --tag "$RELEASE_IMAGE" "$REPOSITORY_DIR"
install -m 0644 "$REPOSITORY_DIR/compose.yaml" "$NEXT_COMPOSE"
SIGNAL_FORGE_IMAGE=$RELEASE_IMAGE docker compose --project-directory "$DEPLOY_DIR" \
  --env-file "$DEPLOY_DIR/.env" -f "$NEXT_COMPOSE" config --quiet

SIGNAL_FORGE_DIR=$DEPLOY_DIR SIGNAL_FORGE_BACKUP_IMAGE=$ROLLBACK_IMAGE \
  bash "$REPOSITORY_DIR/scripts/backup.sh"
BACKUP=$(find "$DEPLOY_DIR/backups" -maxdepth 1 -type f -name 'app-*.db.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)
if [[ -z "$BACKUP" || ! -f "$BACKUP" ]]; then
  echo "Pre-deployment backup was not created" >&2
  exit 1
fi

cp "$COMPOSE_FILE" "$PREVIOUS_COMPOSE"
docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" stop app
STOPPED=1

run_release() {
  docker run --rm --network none --env-file "$DEPLOY_DIR/.env" \
    -v "$DEPLOY_DIR/data:/app/data" \
    -v "$DEPLOY_DIR/signal-forge.json:/app/signal-forge.json:ro" \
    "$RELEASE_IMAGE" "$@"
}

run_release bun -e 'const { openDatabase } = await import("./dist/src/storage/database.js"); openDatabase(process.env.DATABASE_URL).close()'
run_release bun dist/scripts/migrate-claude-web.js
run_release bun dist/scripts/backfill-leaderboards.js

mv -f "$NEXT_COMPOSE" "$COMPOSE_FILE"
printf 'SIGNAL_FORGE_IMAGE=%s\n' "$RELEASE_IMAGE" > "$IMAGE_ENV.next"
mv -f "$IMAGE_ENV.next" "$IMAGE_ENV"
SIGNAL_FORGE_IMAGE=$RELEASE_IMAGE docker compose --project-directory "$DEPLOY_DIR" \
  --env-file "$DEPLOY_DIR/.env" -f "$COMPOSE_FILE" up -d --wait --wait-timeout 180

docker tag "$RELEASE_IMAGE" signal-forge:latest
install -d -m 0755 "$DEPLOY_DIR/scripts"
install -m 0755 "$REPOSITORY_DIR/scripts/backup.sh" "$DEPLOY_DIR/scripts/backup.sh"
rm -f "$PREVIOUS_COMPOSE"
docker image rm "$ROLLBACK_IMAGE" >/dev/null 2>&1 || true
trap - EXIT
echo "Production is healthy on release $DEPLOY_RELEASE"
