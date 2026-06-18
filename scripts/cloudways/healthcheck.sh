#!/usr/bin/env bash
# Lightweight health check for monitoring (cron, uptime-robot, statuscake).
#
# Probes:
#   1. https://$DOMAIN/api/health             — public API health (expects 200)
#   2. https://$DOMAIN/api/auth/me            — sanity that auth gate works (expects 401, no cookie)
#   3. https://$DOMAIN/                       — SPA HTML served (expects 200)
#
# Exit code:
#   0  — all probes passed
#   1  — one or more probes failed (details on stderr)
#
# Optional env:
#   HEALTHCHECK_TIMEOUT   curl timeout in seconds (default 8)
#   HEALTHCHECK_DOMAIN    override DOMAIN from .env (useful for staging)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set +u
  source "$REPO_ROOT/.env"
  set -u
fi

DOMAIN="${HEALTHCHECK_DOMAIN:-${DOMAIN:-}}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-8}"

if [[ -z "$DOMAIN" ]]; then
  echo "[healthcheck] DOMAIN is not set (in .env or HEALTHCHECK_DOMAIN)" >&2
  exit 2
fi

fail=0
ok() { echo "[healthcheck] ok    $*"; }
err() { echo "[healthcheck] fail  $*" >&2; fail=$((fail + 1)); }

probe() {
  local url="$1" expected="$2"
  local actual
  actual="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    -H 'Accept: application/json' "$url" || echo '000')"
  if [[ "$actual" == "$expected" ]]; then
    ok "$url -> $actual"
  else
    err "$url -> $actual (expected $expected)"
  fi
}

probe "https://${DOMAIN}/api/health"   "200"
probe "https://${DOMAIN}/api/auth/me"  "401"
probe "https://${DOMAIN}/"             "200"

if [[ "$fail" -gt 0 ]]; then
  echo "[healthcheck] $fail probe(s) failed" >&2
  exit 1
fi
exit 0
