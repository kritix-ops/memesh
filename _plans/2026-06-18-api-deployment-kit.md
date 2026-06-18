# API Deployment Kit

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, NEXT step 1)

This plan covers the first half of the handoff's NEXT step: the deployment kit that lets the API run anywhere a Docker host is available. The frontend API client is the next plan after this one.

---

## 1. Goals

- Take the existing Fastify API + Drizzle + Postgres schema from "tested locally on PGlite" to "running in a real Postgres-backed container stack on any Docker host."
- Ship a single command (`docker compose up -d`) that boots api + Postgres + Redis on a developer's laptop or on the eventual Cloudways server with no manual hand-holding.
- Include a seed script that runs migrations and creates the first admin staff member, so login works the first time the stack comes up.
- Decide and document the deployment topology (single-origin vs split) so the Dockerfile, Compose, and cookies all line up.
- Stay reversible: nothing in this kit blocks the eventual choice of Vercel-fronted vs single-origin if Yanai picks differently than the recommendation.

Success looks like: from a clean machine with Docker installed, `cp .env.example .env`, fill in three secrets, `docker compose up -d`, `pnpm seed:admin`, then `curl -X POST localhost:3001/auth/login` returns a session cookie for the seeded admin.

## 2. Locked decisions

### 2.1 Topology: single-origin on Cloudways

Recommended over Vercel-frontend + Cloudways-API. Reasons:

- Same-site cookies trivially work. The handoff explicitly warned against the cross-site `*.vercel.app` -> `api.memesh.co.il` pattern (third-party cookies blocked in modern browsers).
- One box, one bill, one place to look when something breaks.
- Vercel's preview deploys are nice but not load-bearing for a solo dev on an internal tool.

Reversible: if we later move the frontend to Vercel, we put it on `app.memesh.co.il` (same site as `api.memesh.co.il`), so cookies stay SAME-SITE. Nothing in this kit blocks that.

Pending: Yanai's confirmation he has Cloudways admin access; the recommendation does not change either way.

### 2.2 Runtime model: tsx in production, not tsc-compiled

Workspace packages (`@memesh/auth`, `@memesh/db`, `@memesh/qr-engine`, `@memesh/sms`) export `./src/index.ts` directly with no build step. A compiled `dist/server.js` cannot load them, so production runs the same way dev does: `tsx src/server.ts`.

Why: forcing every workspace package to also emit `dist/` doubles maintenance for a solo dev. tsx's runtime overhead is invisible at low-thousands-rps; this API will see far less. Standard production-tsx pattern in 2026 for monorepo-internal services.

Rejected: tsc-build-the-whole-tree via TS project references. More machinery for no production-relevant benefit on this stack.

### 2.3 Stack in the Compose file

- `api`: Node 24 alpine + corepack pnpm + tsx. Custom Dockerfile.
- `postgres`: `postgres:16-alpine`. Persistent volume for data. Healthcheck. Internal-only network (exposed to host only in dev via env override).
- `redis`: `redis:7-alpine`. No persistence (rate-limit and OTP-cooldown data is intentionally ephemeral). Healthcheck. Internal-only.

The API container does NOT serve the frontend bundle. Static serving belongs to a future `web` service (Caddy or Nginx in front) — out of scope for this plan; the frontend ships separately to Vercel today.

### 2.4 Secrets and env

- `.env` at the repo root, gitignored (already in `.gitignore`).
- `.env.example` at the repo root, committed, with generation hints for every secret.
- Compose loads `.env` automatically (Compose's default behavior).
- No secrets baked into images, ever.

### 2.5 Seed strategy

- `scripts/seed-admin.ts` at the repo root. Runs against whatever `DATABASE_URL` points at.
- Idempotent: if a staff row already exists with the seeded phone, no-op + log "already seeded".
- Takes phone + password from env vars (`SEED_ADMIN_PHONE`, `SEED_ADMIN_PASSWORD`) so secrets never land in a script file.
- Uses `@memesh/db.createStaff` + `@memesh/auth.hashPassword` — no custom DB code in the script.

## 3. Files this kit produces

```
docker-compose.yml                 # api + postgres + redis (root)
apps/api/Dockerfile                # multi-stage Node 24 + pnpm + tsx
apps/api/.dockerignore             # node_modules, .env, .git, dist
.env.example                       # root, all required vars + hints
scripts/seed-admin.ts              # runs migrations + creates first admin
scripts/seed-admin.test.ts         # unit test against PGlite
package.json                       # add seed:admin script
apps/api/.env.example              # cleaned up (drop stale WC_WEBHOOK_SECRET)
```

No changes to existing source files except the cleanup of the stale `WC_WEBHOOK_SECRET` line.

## 4. Build sequence

1. **Compose stack scaffolding.** Write `docker-compose.yml`, `Dockerfile`, `.dockerignore`, root `.env.example`. Boot the stack with empty volumes. Confirm `docker compose ps` shows all three services healthy.
2. **Run migrations against real Postgres.** From the host: `DATABASE_URL=... corepack pnpm --filter @memesh/db db:migrate`. Confirm the schema lands.
3. **Seed script.** Write `scripts/seed-admin.ts` + a unit test (PGlite, isolated DB). Run it. Confirm a staff row exists with role=admin.
4. **End-to-end smoke.** `curl localhost:3001/health` -> 200. `curl -X POST localhost:3001/auth/login -d {phone,password}` -> session cookie. Tear down with `docker compose down -v`, bring it back up, re-seed, re-login. Proves the loop works fresh-from-zero.
5. **Stale env cleanup.** Drop `WC_WEBHOOK_SECRET` from `apps/api/.env.example` (it is not in `config.ts`; it was leftover from the old branch).
6. **Plan doc updated** with what landed, any deviations, and the next plan (frontend API client).

## 5. Security (rule 13)

- Container user: API runs as non-root inside the container.
- Network: `postgres` and `redis` are NOT exposed to the host in the committed `docker-compose.yml`. A dev who wants psql access edits a local `.env` to expose them. Production binds to `127.0.0.1:PORT` for the API only; Cloudways' reverse proxy (or Caddy) terminates TLS in front.
- Secrets: never in code, never in images, never logged. The seed script reads `SEED_ADMIN_PASSWORD` from env, hashes it with scrypt, then drops the plaintext.
- Postgres: trust-no-host config; `POSTGRES_PASSWORD` required. SSL not enforced on the internal network (loopback inside the Docker network); will be revisited if Postgres ever moves off-box.
- Redis: protected mode + password (`REDIS_PASSWORD`), even internally. Defense-in-depth against a compromised neighbor on shared infra.
- Image hygiene: pinned major versions (`postgres:16-alpine`, `redis:7-alpine`). Renovate can bump minors later; we never use `:latest`.
- Build cache: multi-stage build keeps build-time tools (pnpm cache, dev deps) out of the final image.
- `.dockerignore` keeps `.env`, `.git`, `node_modules`, secrets out of the build context entirely.

## 6. Observability (rule 14)

- API already namespaces logs (`[auth login]`, `[api boot]`, etc.). No changes needed.
- The seed script logs `[seed admin] ...` at each step (env loaded, hash computed, row inserted, done).
- Compose: services produce Docker logs by default; `docker compose logs -f api` works out of the box.
- `/health` returns `{status, env, timestamp}` — Compose healthcheck hits it.

## 7. Testing (rule 18)

- `scripts/seed-admin.test.ts`: PGlite-backed, isolated. Tests: (a) creates an admin on a fresh DB; (b) idempotent — second run is a no-op + log; (c) refuses to run if `SEED_ADMIN_PASSWORD` is missing or shorter than 12 chars; (d) hash verifies via `verifyPassword`.
- Full affected suites run after the seed script lands: `corepack pnpm --filter @memesh/db --filter @memesh/auth --filter @memesh/api test`. The handoff's 82 tests must still pass.
- End-to-end smoke (manual): the boot + curl loop in section 4 step 4.

## 8. Settings (rule 15)

No user-facing settings this kit. The deployment kit is operator-facing. Operator knobs go into env vars (`.env.example`) with one-line comments, not a settings UI. When the eventual admin UI gets a "Server" tab, those env values become read-only display fields — never editable from the browser, because changing them needs a container restart.

## 9. Yanai blockers

This kit can be fully built, tested, and run locally without any input from Yanai. He is needed at three specific points downstream:

1. **Before deploying to Cloudways**: server access credentials + confirmation the Cloudways plan has Docker + enough RAM to host api + Postgres + Redis alongside WP.
2. **Before turning on WP sync**: `WP_BASE_URL`, `WP_SYNC_USER`, `WP_SYNC_APP_PASSWORD`. Until then the sync seam stays disabled (already handled in code — optional env).
3. **Before turning on inbound WC purchase** (only if Yanai promotes it from Phase 2 to Phase 1): WC product ID + webhook secret + topology choice.

None of these block today.

## 10. Out of scope (deferred)

- Production reverse proxy / TLS termination (Cloudways or Caddy in front; configured at deploy time, not in this kit).
- Backup runbook + tested restore drill for the self-managed Postgres container (plan §9.4 — pre-launch).
- Real-Postgres concurrency test for the atomic punch (now unblocked by this kit; lands in its own small follow-up).
- Frontend API client + flipping surfaces from mock to live (next plan after this one).
- WP inbound webhook (deferred to Phase 2 unless Yanai promotes it).

## 11. Alternatives rejected

- **One mega-image with frontend baked in.** Couples deploy cadence of frontend and api (one slow build for both), and prevents the frontend from staying on Vercel if we want. Rejected.
- **Postgres on the host (not in Compose).** Saves a layer of indirection but loses repeatability and clean teardown. Rejected; the box is the api's only neighbor anyway.
- **Run `node dist/server.js` via a multi-package tsc build.** Doubles the build matrix for every package, every release, for no production-relevant benefit at this stack's load. Rejected.
- **Use `nodemon` in dev container.** `tsx watch` already does this in dev; the Compose API container is for prod-shape testing, not for hot-reload dev.

## 12. Open questions

None blocking. The single open question — single-origin vs split topology — is recommended above; Yanai's confirmation does not block building the kit because nothing in it is incompatible with either choice.
