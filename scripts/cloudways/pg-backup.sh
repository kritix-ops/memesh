#!/usr/bin/env bash
# Nightly Postgres backup for Memesh.
#
# Writes a custom-format pg_dump to $BACKUP_DIR (default: /var/backups/memesh).
# Rotates: keeps the newest $BACKUP_RETENTION_DAYS dumps (default: 14).
#
# Designed to be run from cron as the user that owns the repo directory
# (so it can read .env). Logs to syslog with tag memesh-backup.
#
# The off-box upload step is left as a TODO at the bottom — pick a
# destination (Backblaze B2 / S3 / DO Spaces) and add one rclone or aws
# s3 line. The dump file path is in $DUMP after this script runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
set +u
source .env
set -u

BACKUP_DIR="${BACKUP_DIR:-/var/backups/memesh}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
POSTGRES_USER="${POSTGRES_USER:-memesh}"
POSTGRES_DB="${POSTGRES_DB:-memesh}"

# Resolve a logger that works on cloudways + plain linux. Falls back to echo
# if logger is missing.
log() {
  if command -v logger >/dev/null 2>&1; then
    logger -t memesh-backup -- "$*"
  fi
  echo "[memesh-backup] $*"
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/memesh-${TIMESTAMP}.dump"

log "starting dump: $DUMP"

# Run pg_dump inside the postgres container; redirect to a file on the host.
# We use --format=custom for parallelism + compression at restore time.
if ! docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  pg_dump --format=custom --no-owner --no-acl \
  --username="$POSTGRES_USER" "$POSTGRES_DB" > "$DUMP"; then
  log "pg_dump failed"
  rm -f "$DUMP"
  exit 1
fi

chmod 600 "$DUMP"

SIZE_BYTES=$(stat -c '%s' "$DUMP" 2>/dev/null || stat -f '%z' "$DUMP")
log "dump complete: $DUMP (${SIZE_BYTES} bytes)"

# Rotate: delete dumps older than RETENTION_DAYS.
log "rotating dumps older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -type f -name 'memesh-*.dump' -mtime "+${RETENTION_DAYS}" -print -delete \
  2>&1 | while read -r line; do log "removed $line"; done

# TODO: off-box upload. Uncomment one of:
#   rclone copy "$DUMP" b2:memesh-backups/$(date -u +%Y/%m)/ 2>&1 | tee >(logger -t memesh-backup)
#   aws s3 cp "$DUMP" s3://memesh-backups/$(date -u +%Y/%m)/ --region eu-central-1
#   s3cmd put "$DUMP" s3://memesh-backups/$(date -u +%Y/%m)/

log "done"
