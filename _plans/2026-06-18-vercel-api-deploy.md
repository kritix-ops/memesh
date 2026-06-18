# Vercel API deploy (replaces Cloudways path)

Goal: make login work on `memesh-opal.vercel.app`. The Vercel deploy is web-only; `/api/*` 404s, so the login UI shows "Login failed."

## Decision

Deploy `apps/api` as a SEPARATE Vercel project. Add a rewrite in `apps/web/vercel.json` so `memesh-opal.vercel.app/api/*` proxies to the API project. Same origin from the browser's perspective → no CORS, no cookie issues.

Why not co-host in the existing project: would require wrapping Fastify as a function file inside `apps/web/api/`, cross-package imports, monorepo bundling risk. Two-project approach is the standard Vercel monorepo pattern and avoids all of that.

Why not Cloudways/Cloudflare Tunnel: still valid, but the user is already deployed on Vercel and the Vercel-native path is faster to ship today. Cloudways co-location with WordPress is no longer a deployment requirement — the API calls WP over HTTPS just fine from any cloud.

## Architecture

```
                Browser
                   │
                   ▼
         memesh-opal.vercel.app
         (Vite SPA, existing project)
                   │
                   │  /api/auth/login → rewrite
                   ▼
         memesh-api.vercel.app
         (Fastify, new project — same repo, root=apps/api)
                   │
                   ▼
              Neon (Postgres)

   memesh.co.il (WordPress on Cloudways) ←─── HTTPS sync from API
```

## Vercel auto-detects Fastify

Verified via Context7: Vercel docs say Fastify deploys with zero config when entry file is at `src/server.ts` (or `src/app.ts` / `src/index.ts` / root variants). `apps/api/src/server.ts` already matches.

## Required env vars on the new API project

| Var | Value | Source |
|---|---|---|
| `NODE_ENV` | `production` | literal |
| `DATABASE_URL` | Neon pooled URL | copy from existing project, or attach Neon integration |
| `SERVER_SECRET_KEY` | 32+ char random | generate fresh |
| `JWT_SECRET` | 32+ char random, different from above | generate fresh |
| `LOG_LEVEL` | `info` | literal |
| `QR_KEY_ID` | `1` | literal |
| `JWT_ISSUER` | `memesh` | literal |
| `JWT_AUDIENCE` | `memesh-api` | literal |
| `JWT_CUSTOMER_AUDIENCE` | `memesh-customer` | literal |
| `SMS_PROVIDER` | `console` | literal (real SMS comes later) |
| `WP_BASE_URL` | `https://memesh.co.il/wp-json/wp/v2` | from .env |
| `WP_SYNC_USER` | from .env | copy |
| `WP_SYNC_APP_PASSWORD` | from .env | copy |

## Steps

1. **User**: vercel.com → Add New → Project → import same GitHub repo (`kritix-ops/memesh`).
2. **User**: Configure project:
   - Name: `memesh-api` (this becomes the URL: `memesh-api.vercel.app`)
   - Root Directory: `apps/api`
   - Framework Preset: auto-detect (should pick Fastify)
   - Install Command: leave default (Vercel handles pnpm workspace)
3. **User**: add env vars from the table above BEFORE first deploy (otherwise the Fastify boot fails the Zod env parse and the deploy errors out).
4. **User**: deploy. Note the assigned URL.
5. **Me**: if Vercel assigned a different URL than `memesh-api.vercel.app`, update the rewrite in `apps/web/vercel.json`.
6. **User**: ensure admin row exists in Neon. Run `pnpm --filter=@memesh/api seed:admin` locally (env vars in root `.env`). If output says `created` or `already_seeded`, admin is good.
7. **User**: push (or trigger redeploy of memesh-opal.vercel.app) so the new rewrite takes effect.
8. **Verify**: `curl https://memesh-opal.vercel.app/api/health` should return JSON `{status: "ok", ...}`.
9. **Log in** at `memesh-opal.vercel.app/admin` with the seeded phone + password.

## Open items

- Cookie domain: API sets cookies for path `/`. Because the browser sees same-origin (Vercel rewrite), cookies should attach. Verify in browser devtools after first login.
- DATABASE_URL: Neon's serverless connection pooler is what the existing setup uses — fine on Vercel Functions (no per-invocation pool exhaustion).
- Cold starts: ~1-2s on free tier. Fluid Compute on the project reduces this; enable in project settings.
- No Cloudflare Tunnel work needed anymore unless we want to put the API on Cloudways later.

## What this kills

- `_plans/2026-06-18-cloudways-deployment-kit.md` (Docker on Cloudways): not needed; Vercel handles deploy.
- Cloudflare Tunnel research and the planned `scripts/cloudways-native/`: not needed.
- The Docker Compose files (`docker-compose.yml`, `Dockerfile`) remain in the repo as documentation / future option but are unused.
