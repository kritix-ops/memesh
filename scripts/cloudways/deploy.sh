#!/usr/bin/env bash
# Subsequent deploys on Cloudways (or any Docker host).
#
# What this does, in order:
#   1. git pull --ff-only  (refuses to merge or rebase — clean fast-forwards only)
#   2. pnpm install --frozen-lockfile
#   3. pnpm --filter @memesh/web build  (rebuilds the SPA dist)
#   4. docker compose up -d --build api  (rebuilds the api image, restarts it)
#   5. waits for healthchecks
#   6. smoke-tests https://$DOMAIN/api/health
#
# If anything fails, the script exits non-zero and the previous version
# keeps running (compose only restarts a service after a successful build).
#
# To roll back: git checkout <known-good-sha>; bash scripts/cloudways/deploy.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[deploy] $*"; }
err() { echo "[deploy] error: $*" >&2; }

if [[ ! -f .env ]]; then
  err "no .env at $REPO_ROOT/.env — run scripts/cloudways/bootstrap.sh first"
  exit 1
fi

# shellcheck disable=SC1091
set +u
source .env
set -u

if [[ -z "${DOMAIN:-}" ]]; then
  err "DOMAIN is not set in .env"
  exit 1
fi

log "git pull --ff-only"
git pull --ff-only

log "installing pnpm dependencies (frozen lockfile)"
corepack pnpm install --frozen-lockfile

log "building the web app"
corepack pnpm --filter @memesh/web build

log "rebuilding api image and restarting"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build api

# Caddy reload not needed: the SPA is mounted as a volume, so the new dist
# is served the moment the build completes.
log "reloading Caddy (no-op if config unchanged; picks up new SPA dist immediately)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile || true

log "waiting for api healthcheck (timeout ~60s)"
for i in {1..20}; do
  if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps api --format json | grep -q '"Health":"healthy"'; then
    log "api healthy"
    break
  fi
  sleep 3
  if [[ "$i" -eq 20 ]]; then
    err "api did not become healthy"
    docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 100 api
    exit 1
  fi
done

log "smoke-testing https://${DOMAIN}/api/health"
if curl -fsS "https://${DOMAIN}/api/health" >/dev/null; then
  log "OK — deploy complete"
else
  err "smoke test failed"
  exit 1
fi
