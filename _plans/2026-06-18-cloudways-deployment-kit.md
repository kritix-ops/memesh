# Cloudways production deployment kit + runbook

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-18-api-deployment-kit.md` (the local Compose stack this builds on top of).
Predecessor: `_plans/2026-06-18-scan-qr-flow.md`

Closes the gap between "Compose stack runs locally" and "real Memesh API running on a Cloudways server with TLS + DNS + backups + monitoring". The actual deploy still needs Yanai's Cloudways access — this chunk makes day-one with that access a single runbook to follow, not weeks of figuring things out.

---

## 1. Goals

- One-command initial deploy on a fresh Cloudways box: `bash scripts/cloudways/bootstrap.sh`.
- TLS terminated by Caddy (auto Let's Encrypt) on the configured `DOMAIN`. Same origin serves the SPA (static `apps/web/dist`) at `/` and the API at `/api/*`. Single-origin topology per the original API plan §2.1.
- Subsequent deploys: `bash scripts/cloudways/deploy.sh` (git pull → rebuild SPA → docker compose up).
- Nightly `pg_dump` to a local backup directory with 14-day rotation. Off-box upload is a documented follow-up (Yanai-blocker for storage destination).
- Health check script suitable for cron-based uptime monitoring.
- Secrets generator that scaffolds a production `.env` with cryptographically-random values.

Success: Yanai shares SSH + DNS + a server that has Docker. Within an hour, `https://memesh.co.il` serves the SPA, `https://memesh.co.il/api/health` returns 200, the staff admin can log in, and `pg_dump` ran once successfully.

## 2. Locked decisions

### 2.1 Caddy 2 as the front proxy (TLS + static + reverse proxy)

Caddy auto-provisions Let's Encrypt certs, supports HTTP/3, and has a single-file config that handles both static serving and reverse proxy. Versus nginx: less config, no certbot dance, no reload on cert renewal. Versus Traefik: lighter and the dynamic-config superpower isn't needed for a one-server setup.

### 2.2 Compose override file, not branches

`docker-compose.yml` stays as-is (good for dev). Production adds `docker-compose.prod.yml` which:

- Adds the `caddy` service (ports 80/443 → public).
- Removes the api's host-port binding (caddy reaches it on the internal network).
- Removes the postgres + redis host-port bindings (they were never bound, just defensive).

Invocation: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. The deploy script does this implicitly.

### 2.3 SPA built on the server, mounted into Caddy as a volume

Frontend dist (`apps/web/dist`) is a static directory. Caddy mounts it read-only at `/srv/web`. The deploy script runs `pnpm --filter @memesh/web build` on the server, producing the dist; Caddy serves it directly. No frontend container.

Alternative considered: build SPA in CI, push the artifacts via scp. Cleaner separation but requires CI setup we don't have yet. Building on the server is fine at this size (a few seconds, runs once per deploy).

### 2.4 Local backups + Cloudways snapshots as the day-one strategy

- Local: `pg_dump` to `/var/backups/memesh/`, rotate (keep 14 days). Runs nightly via cron (template included).
- Cloudways: their built-in server snapshots, configured in their dashboard, run independently.

This satisfies "have backups" for day-one. The brief §9.4 also asks for "off-box storage in-region" — that needs a destination (Backblaze B2 EU, AWS S3 Frankfurt, or DigitalOcean Spaces) Yanai picks. The backup script is structured so the off-box upload is a one-line addition (`rclone copy` / `aws s3 cp`) when the destination exists.

### 2.5 Cookies stay path `/`

Already done in the staff-login chunk. With Caddy stripping the `/api` prefix the cookie still travels with every request to `memesh.co.il` (same origin). No further changes needed.

### 2.6 HSTS: 1 year, includeSubDomains

`Strict-Transport-Security: max-age=31536000; includeSubDomains` — standard production value. If the first cert provisioning fails, fix and redeploy; HSTS only applies on a successful HTTPS response. (No preload directive — that requires a separate submission process we're not doing yet.)

## 3. Files this chunk produces

```
caddy/Caddyfile                              # TLS + /api proxy + SPA static + security headers
docker-compose.prod.yml                       # caddy service + no host bindings on api/db/redis
scripts/cloudways/bootstrap.sh                # first-time setup (interactive)
scripts/cloudways/deploy.sh                   # subsequent deploys (git pull + build + restart)
scripts/cloudways/generate-secrets.sh         # scaffolds a production .env
scripts/cloudways/pg-backup.sh                # nightly pg_dump + 14-day rotation
scripts/cloudways/pg-backup.cron              # cron line template
scripts/cloudways/healthcheck.sh              # for monitoring (cron / uptime service)
scripts/cloudways/README.md                   # quick reference for each script
.env.example                                  # DOMAIN + LETSENCRYPT_EMAIL + backup dir
_plans/2026-06-18-cloudways-deployment-kit.md # this plan (also the runbook in §11)
```

No backend or frontend source changes. No new tests (these are shell scripts; manual smoke is the test).

## 4. Build sequence

1. Caddyfile + Compose override.
2. `generate-secrets.sh` (lowest dependency).
3. `bootstrap.sh` (calls generate-secrets + builds + seeds).
4. `deploy.sh`.
5. `pg-backup.sh` + cron template.
6. `healthcheck.sh`.
7. README + .env.example update.
8. Lint pass + format + commit.

## 5. Security (rule 13)

- Caddy auto-provisions Let's Encrypt, auto-renews. We never touch private keys directly.
- HSTS, X-Content-Type-Options, Referrer-Policy headers set by default.
- Postgres + Redis only reachable on the internal Compose network; no public exposure.
- API only reachable through Caddy on `/api/*`; the api container does not bind any host port in prod.
- Secrets generated by `generate-secrets.sh` use `node -e crypto.randomBytes(32).toString('hex')` — same primitive as elsewhere in the codebase. The script writes to `.env` with mode 600 and reminds the operator to never commit it.
- The seed-admin step prompts for the phone + password interactively; the password is read with `read -s` (no echo).
- `pg-backup.sh` writes dumps owned by the postgres user with mode 600. The 14-day rotation prevents disk-fill, but operators should still configure a disk alarm.
- Health check probes `/api/health` (public) and a private staff-login-401 sanity (no auth → expects 401). No credentials in the script.

## 6. Observability (rule 14)

- Caddy logs every request to stdout in JSON format. `docker compose logs caddy` for live tailing.
- API + db + redis logs already covered via `docker compose logs <service>`.
- Cron output from pg-backup writes to syslog with a `[memesh-backup]` tag.
- Healthcheck script returns exit code 0/1 — feeds into any cron, uptime-robot, or systemd timer.

## 7. Testing (rule 18)

- Shell scripts are tested via execution (manual smoke during the first bootstrap).
- The Compose stack itself was tested locally via tests as far as I can without Docker on this dev machine. The first real test is on Cloudways.
- The runbook in §11 includes a "first-deploy verification" checklist that doubles as a smoke test.
- No new unit tests (no new code paths in the application).

## 8. Settings (rule 15)

No new user-facing settings. Operator settings live in env vars:

- `DOMAIN` — the public hostname.
- `LETSENCRYPT_EMAIL` — where Let's Encrypt sends expiry warnings if renewal stalls.
- `BACKUP_DIR` — where `pg-backup.sh` writes dumps (default `/var/backups/memesh`).
- `BACKUP_RETENTION_DAYS` — rotation window (default 14).
- All existing env vars from the api deployment kit still apply.

## 9. Yanai blockers (open until done)

These must be resolved before the first real deploy:

1. **Cloudways access**: SSH credentials to the server + confirmation the plan supports Docker + ~2GB+ RAM. If the existing WordPress server doesn't fit, provision a new server (Cloudways or a DO/Hetzner VPS in EU region).
2. **DNS control**: create an A record for the public hostname (`memesh.co.il` or `app.memesh.co.il`) pointing to the Cloudways server IP. Caddy can't get a TLS cert without DNS pointing right.
3. **Production secrets**: the `generate-secrets.sh` script handles random values, but the operator must pick `SEED_ADMIN_PHONE` and `SEED_ADMIN_PASSWORD` (the first admin's credentials).
4. **Off-box backup destination** (pre-launch, not day-one): Backblaze B2, S3, or DO Spaces. The backup script structure leaves a clear hook for `rclone copy` once a target exists.

## 10. Cost flag (rule 8)

Researched current Cloudways pricing (June 2026):

- **1GB DO Premium**: $14/mo — too small for our stack (api + postgres + redis + caddy + SPA build).
- **2GB DO Premium**: ~$28/mo — comfortable for Phase 1. Recommended starting size.
- **4GB DO Premium**: ~$42/mo — headroom if punch volume grows.

Plus Cloudways add-ons typically off by default. Reasonable starting spend: **~$28/mo for the API stack**, separate from whatever WordPress already costs Yanai.

Alternatives I considered (rule 17 — no brand bias):

- **DigitalOcean direct**: same hardware, ~$24/mo for 2GB premium, but Yanai handles OS updates and security patches himself. Cloudways adds ~$4/mo for managed-ops convenience.
- **Hetzner CCX cloud (EU-region)**: ~$8/mo for a 2-CPU/4GB box. Much cheaper, fewer managed conveniences, requires more sysadmin attention.
- **Fly.io / Railway**: managed PaaS, easier ops, ~$30–60/mo for similar resources. Vendor lock-in higher.

For this project the lock-in already favors Cloudways (existing WordPress relationship, Yanai's familiarity). Recommendation: stick with Cloudways for Phase 1; reconsider only if cost or performance issues surface.

## 11. The Runbook

### 11.1 Prerequisites

On the Cloudways server (one-time):

- Docker + Docker Compose v2 installed (Cloudways supports Docker on most plans; verify before purchasing if new).
- `git` installed.
- SSH access for the operator.
- DNS A record for `DOMAIN` points to the server IP.
- Ports 80 + 443 open to the public internet.

### 11.2 First deploy

```bash
# 1. Pull the repo
ssh memesh-cloudways
cd /home/master/applications/memesh   # or wherever you choose
git clone https://github.com/kritix-ops/memesh.git
cd memesh
git checkout main   # or feat/phase1-secure-core for the current branch

# 2. Bootstrap (interactive — prompts for the seed admin)
bash scripts/cloudways/bootstrap.sh
#   - generates secrets into .env
#   - asks for DOMAIN, LETSENCRYPT_EMAIL
#   - asks for SEED_ADMIN_PHONE + SEED_ADMIN_PASSWORD
#   - builds the SPA dist
#   - docker compose up -d
#   - waits for healthchecks
#   - runs seed:admin (creates the first staff member)

# 3. Verify
curl -fsS https://${DOMAIN}/api/health        # expect 200 ok
curl -fsS https://${DOMAIN}/                  # expect HTML (the SPA)
# In a browser: log in with the seed admin

# 4. Configure backups
sudo cp scripts/cloudways/pg-backup.cron /etc/cron.d/memesh-backup
sudo systemctl restart cron
# First backup runs at 02:30 server time; confirm with: ls -la /var/backups/memesh/

# 5. (Optional) configure health monitoring
# Add scripts/cloudways/healthcheck.sh to your monitoring system
# Example: */5 * * * * /home/master/applications/memesh/scripts/cloudways/healthcheck.sh
```

### 11.3 Subsequent deploys

```bash
ssh memesh-cloudways
cd /home/master/applications/memesh
bash scripts/cloudways/deploy.sh
#   - git pull
#   - corepack pnpm install --frozen-lockfile
#   - pnpm --filter @memesh/web build
#   - docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build api
#   - waits for the api healthcheck to pass
```

### 11.4 Rollback

```bash
ssh memesh-cloudways
cd /home/master/applications/memesh
git log --oneline -10    # find the last-known-good commit
git checkout <sha>
bash scripts/cloudways/deploy.sh
```

For a DB schema rollback: `pg_restore` from the most recent backup before the bad migration. Out of scope for this runbook beyond pointing at the dumps in `/var/backups/memesh/`.

### 11.5 Backup verification (run once before launch)

```bash
# 1. Trigger a backup manually
bash scripts/cloudways/pg-backup.sh

# 2. Pick the newest dump
ls -lh /var/backups/memesh/

# 3. Restore it into a throwaway DB
docker exec memesh-postgres-1 createdb memesh_restore_test
docker exec -i memesh-postgres-1 pg_restore -d memesh_restore_test < /var/backups/memesh/memesh-YYYYMMDD-HHMMSS.dump

# 4. Spot-check
docker exec memesh-postgres-1 psql -d memesh_restore_test -c 'select count(*) from customers'

# 5. Drop the test DB
docker exec memesh-postgres-1 dropdb memesh_restore_test
```

### 11.6 Logs

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f caddy    # access log + tls events
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api      # app log
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f postgres # db log
```

## 12. Out of scope (deferred)

- CI/CD pipeline (GitHub Actions deploying on push to `main`). The deploy script is one ssh+command away from being CI-callable.
- Off-box backups (Yanai picks the destination).
- Per-app metrics dashboard (logs are enough for Phase 1).
- A dedicated staging environment.
- DDoS protection beyond Cloudflare-in-front (which Yanai already uses for WordPress).
- Auto-scaling (single-box for Phase 1 is the locked decision).

## 13. Alternatives rejected

- **nginx in front of api**: more config, more brittle TLS handling. Rejected.
- **Cloudways' built-in WordPress setup with a sibling Node app**: ties the two apps' downtime windows together; harder to reason about. Rejected.
- **Vercel for frontend + Cloudways for API on separate subdomains**: brings the cross-site cookie problem back (the staff-login chunk explicitly avoided this). Rejected for Phase 1; the single-origin Cloudways setup is what cookies want.
- **Kubernetes**: enormous overkill for a one-server Phase 1 app. Rejected.

## 14. Open questions

None blocking the kit itself. The Yanai blockers in §9 are the real-world unblockers.
