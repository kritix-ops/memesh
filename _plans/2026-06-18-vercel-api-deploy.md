# Vercel API deploy (single existing `memesh` project)

Goal: make login work on `memesh-opal.vercel.app`. The Vercel project deploys the web app only; `/api/*` 404s, so the login UI shows "Login failed."

## Decision

Add the Fastify API as a **serverless function inside the existing `memesh` Vercel project**, at `apps/web/api/[...slug].ts`. Vercel auto-detects `api/` folder files as functions and routes `/api/*` to them. Same domain → no CORS, no cookie issues, no second Vercel project to manage.

## Architecture

```
                 Browser
                    │
                    ▼
          memesh-opal.vercel.app   (existing "memesh" project)
            ├── /            → Vite SPA (apps/web/dist)
            └── /api/*       → apps/web/api/[...slug].ts (Vercel Function)
                                  └── wraps Fastify via buildApp()
                                          │
                                          ▼
                                       Neon (Postgres)

   memesh.co.il (WordPress on Cloudways)  ← HTTPS sync from API
```

## How the function bridges Vite SPA + Fastify

- `apps/web/api/[...slug].ts` is a Vercel catch-all function. Any request to `/api/*` is routed to it.
- The handler lazily builds the Fastify app once per cold start (cached at module scope for warm invocations).
- It strips the `/api` prefix from `req.url` (matching the Vite dev proxy behavior in `apps/web/vite.config.ts`), then emits the request to Fastify's underlying http server.
- `apps/api` exports `buildApp` via `package.json#exports["./app"]`, imported as `@memesh/api/app`.
- `apps/web` declares `@memesh/api` as a workspace dependency so the symlink resolves.

## Why not a separate API project

- Cookies must be set on the same domain the browser is talking to. With a same-project deploy, cookies work without any cross-origin gymnastics.
- One project to manage env vars on, one URL to monitor, one Vercel free-tier deployment quota.
- No rewrite needed in `vercel.json` (Vercel auto-routes `/api/*` to the `api/` folder).

## Why not Cloudways anymore

Vercel hosts the web; making it host the API too means the whole app stack is on one platform with one deploy pipeline. Cloudways stays for WordPress only. The API talks to WP over HTTPS — no co-location requirement.

## Required env vars on the existing `memesh` Vercel project

Set in Project Settings → Environment Variables (Production scope):

| Var | Value | Source |
|---|---|---|
| `NODE_ENV` | `production` | literal |
| `DATABASE_URL` | Neon pooled URL | already present (via Vercel-Neon integration) — verify |
| `SERVER_SECRET_KEY` | 32+ char random hex | generate fresh, never reuse |
| `JWT_SECRET` | 32+ char random hex (different from above) | generate fresh, never reuse |
| `LOG_LEVEL` | `info` | literal |
| `QR_KEY_ID` | `1` | literal |
| `JWT_ISSUER` | `memesh` | literal |
| `JWT_AUDIENCE` | `memesh-api` | literal |
| `JWT_CUSTOMER_AUDIENCE` | `memesh-customer` | literal |
| `SMS_PROVIDER` | `console` | literal (real 019 SMS comes later) |
| `WP_BASE_URL` | `https://memesh.co.il/wp-json/wp/v2` | from local .env |
| `WP_SYNC_USER` | (from local .env) | copy |
| `WP_SYNC_APP_PASSWORD` | (from local .env) | copy |

Generate secrets:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Steps

1. **Me (done)**:
   - `apps/api/package.json`: add `exports` field exposing `./app`.
   - `apps/web/package.json`: add `@memesh/api` as workspace dep.
   - `apps/web/api/[...slug].ts`: new Fastify-wrapping catch-all function.
   - `apps/web/vercel.json`: remove the rewrite that pointed to a non-existent `memesh-api.vercel.app`.
   - `pnpm install` + Vite build verified clean.
   - Commit and push.
2. **User**: add the env vars above in the `memesh` Vercel project. Save.
3. **Auto**: Vercel redeploys on the new git push, picks up the new function.
4. **User**: confirm admin row exists in Neon — run `pnpm --filter=@memesh/api seed:admin` locally; expect `created` or `already_seeded`.
5. **Verify**: open `https://memesh-opal.vercel.app/api/health` — should return `{"status":"ok","env":"production","timestamp":"..."}`. If 404, function didn't deploy. If 500, env vars missing/invalid (check Vercel function logs).
6. **Log in** at `https://memesh-opal.vercel.app/admin` with the seeded phone (dashes exactly as in `.env`) and password.

## Cold start expectations

First request to the function after a deploy: 1-3 seconds (Fastify init + db pool warm-up + module load). Subsequent requests within the same warm container: <100ms. Enable Fluid Compute in project settings for better warm-start density.

## Things this supersedes

- `_plans/2026-06-18-cloudways-deployment-kit.md` (Docker on Cloudways): unused.
- Cloudflare Tunnel from cloudways: unused for API deploy. (Cloudflare may still be used cosmetically to put `app.memesh.co.il` in front of this Vercel project — see "Custom domain" below.)
- The Docker Compose files in repo root: kept as reference but not in active use.

## Custom domain (optional, separate track)

To serve at `app.memesh.co.il` instead of `memesh-opal.vercel.app`:
- Cloudflare zone for `app.memesh.co.il` (NS-delegated from livedns.co.il)
- CNAME `@` → `cname.vercel-dns.com` (proxy OFF for SSL issuance)
- Vercel project Settings → Domains → add `app.memesh.co.il`
- Vercel auto-issues Let's Encrypt cert
