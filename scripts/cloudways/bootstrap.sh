#!/usr/bin/env bash
# First-time setup for a Cloudways box (or any Docker host).
#
# What this does, in order:
#   1. Verifies docker + docker compose + pnpm-via-corepack exist.
#   2. Generates .env if missing (calls generate-secrets.sh).
#   3. Prompts for DOMAIN, LETSENCRYPT_EMAIL, SEED_ADMIN_* (with no-echo
#      password input).
#   4. Builds apps/web (the SPA Caddy will serve).
#   5. docker compose up -d (base + prod override).
#   6. Waits for healthchecks to pass.
#   7. Runs seed:admin inside the api container.
#   8. Smoke-tests https://$DOMAIN/api/health.
#
# Idempotent for the early steps; the seed:admin call is idempotent on its
# own (no-op if the admin phone is already in the staff table).
#
# Re-runnable: if you cancel midway, fix the issue and re-run. Already-good
# steps no-op.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[bootstrap] $*"; }
err() { echo "[bootstrap] error: $*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is not installed. $2"
    exit 1
  fi
}

# --- 1. Prereqs -----------------------------------------------------------
require_cmd docker "Install Docker first."
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 is required (got: $(docker --version))."
  exit 1
fi
require_cmd node "Install Node.js 24+ first."
require_cmd corepack "Run: npm install -g corepack && corepack enable"

# --- 2. .env --------------------------------------------------------------
if [[ ! -f .env ]]; then
  log "no .env yet — generating one"
  bash scripts/cloudways/generate-secrets.sh
else
  log ".env already exists; keeping existing secrets"
fi

# --- 3. Interactive fields ------------------------------------------------
# Read each value from .env; if blank, prompt and write it back.
# shellcheck disable=SC1091
set +u
source .env
set -u

prompt_set() {
  local key="$1" prompt="$2" current="${!1:-}" hide="${3:-no}"
  if [[ -n "${current:-}" ]]; then
    log "$key already set; leaving alone"
    return
  fi
  local val
  if [[ "$hide" == "hide" ]]; then
    read -rs -p "$prompt: " val
    echo
  else
    read -r -p "$prompt: " val
  fi
  if [[ -z "$val" ]]; then
    err "$key cannot be empty"
    exit 1
  fi
  # POSIX-portable in-place edit (works on linux + bsd).
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    echo "${key}=${val}" >> .env
  fi
  export "$key=$val"
}

prompt_set DOMAIN "Public domain (e.g. memesh.co.il)"
prompt_set LETSENCRYPT_EMAIL "Email for Let's Encrypt renewal warnings"
prompt_set SEED_ADMIN_PHONE "First admin phone (e.g. 050-000-0000)"
prompt_set SEED_ADMIN_PASSWORD "First admin password (12+ chars, hidden)" hide
prompt_set SEED_ADMIN_FIRST_NAME "First admin first name"
prompt_set SEED_ADMIN_LAST_NAME "First admin last name"

if [[ ${#SEED_ADMIN_PASSWORD} -lt 12 ]]; then
  err "SEED_ADMIN_PASSWORD must be at least 12 characters"
  exit 1
fi

# --- 4. Build the SPA -----------------------------------------------------
log "installing pnpm dependencies (frozen lockfile)"
corepack pnpm install --frozen-lockfile

log "building the web app (apps/web/dist)"
corepack pnpm --filter @memesh/web build

# --- 5. docker compose up -------------------------------------------------
log "starting the stack (api + postgres + redis + caddy)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# --- 6. Wait for healthchecks --------------------------------------------
log "waiting for healthchecks to pass (timeout ~120s)..."
for i in {1..40}; do
  if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --format json \
    | grep -q '"Health":"healthy"'; then
    # Check that ALL services are healthy, not just one.
    UNHEALTHY=$(docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --format json \
      | grep -v '"Health":"healthy"' | grep '"Health":' | wc -l)
    if [[ "$UNHEALTHY" -eq 0 ]]; then
      log "all services healthy"
      break
    fi
  fi
  sleep 3
  if [[ "$i" -eq 40 ]]; then
    err "services did not become healthy in time. docker compose ps:"
    docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
    exit 1
  fi
done

# --- 7. Seed the first admin ----------------------------------------------
log "seeding the first admin (idempotent — no-op if phone already exists)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api pnpm seed:admin

# --- 8. Smoke test --------------------------------------------------------
log "smoke-testing https://${DOMAIN}/api/health"
sleep 5   # give Let's Encrypt a moment for the first cert
if curl -fsS "https://${DOMAIN}/api/health" >/dev/null; then
  log "OK — production API responds at https://${DOMAIN}/api/health"
else
  err "smoke test failed. Check: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy"
  err "Likely causes: DNS not pointing here yet (let it propagate), ports 80/443 blocked, Let's Encrypt rate-limit."
  exit 1
fi

log "bootstrap done."
log "next steps:"
log "  - log in at https://${DOMAIN} as ${SEED_ADMIN_PHONE} / (the password you just set)"
log "  - configure cron for nightly backups: sudo cp scripts/cloudways/pg-backup.cron /etc/cron.d/memesh-backup"
log "  - run the backup-restore drill at least once before going live (see runbook §11.5)"
