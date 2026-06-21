---
title: Phase 6 runbook — Vercel projects + Cloudflare DNS + cutover
date: 2026-06-21
status: ready
owner: Yoav
---

# Phase 6 runbook

Wires four Vercel projects (`memesh-staff`, `memesh-admin`, `memesh-customer`, `memesh-api`) to four subdomains via Cloudflare DNS-only CNAMEs, sets the must-match shared secrets, and verifies each subdomain end-to-end. Apex `memesh.co.il` stays on WordPress and is never touched.

Expect ~30–45 minutes of dashboard work, plus DNS propagation (usually < 5 min on Cloudflare DNS-only) and TLS issuance (usually < 2 min on Vercel).

---

## Before you start

You need:
- Vercel dashboard access to the `memesh` Vercel project and rights to create three more projects on the same team.
- Cloudflare access to the `memesh.co.il` zone with rights to add CNAME records.
- Access to whatever stores the current production secrets (the existing `memesh` Vercel project's env vars).
- A scratch buffer (note app, password manager — NOT Slack or email) to copy secrets between dashboards.
- ~30 minutes of uninterrupted time. The cookie-domain step is the production-accident risk in section 5; do not start if you'll be interrupted mid-cutover.

You do NOT need:
- Vercel CLI installed (we can do everything through the dashboard).
- DNS access to the apex `memesh.co.il` record — it stays on WordPress.
- Any code changes — Phase 5 already left the repo in the right shape.

---

## 0. Capture current production secrets (do this first)

Open the existing `memesh` Vercel project → Settings → Environment Variables. Copy these to a scratch buffer. You'll paste them into `memesh-api` in section 5.

**Must capture exactly (mismatched values break customers):**

- `DATABASE_URL` — the Neon Postgres connection string.
- `SERVER_SECRET_KEY` — peppers OTPs and signs QR tokens. **If this changes, every existing punch card's QR code stops verifying and every active OTP fails.** This is the single most important secret to copy verbatim.
- `JWT_SECRET` — signs staff access + refresh tokens. Mismatch = every staff member gets force-logged-out on first request. Inconvenient but not data-destroying.
- `QR_KEY_ID` — the active QR signing key label. Keep it the same so existing cards' `keyId` matches.

**Likely-present, copy if set:**

- `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_CUSTOMER_AUDIENCE` — defaults `memesh`, `memesh-api`, `memesh-customer` if unset.
- `LOG_LEVEL` — defaults to `info`.
- `SMS_PROVIDER`, `PULSEEM_API_KEY`, `PULSEEM_FROM_NUMBER`, `PULSEEM_BASE_URL` — SMS OTP delivery.
- `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` — email-OTP fallback.
- `WP_BASE_URL`, `WP_SYNC_USER`, `WP_SYNC_APP_PASSWORD` — WordPress customer sync.
- `WC_WEBHOOK_SECRET`, `CRON_SECRET`, `WC_API_URL`, `WC_API_CONSUMER_KEY`, `WC_API_CONSUMER_SECRET`, `WC_RECONCILE_LOOKBACK_HOURS` — WooCommerce webhook + reconciliation cron.

**Do NOT copy these from the old project; they get fresh values:**

- `NODE_ENV` — set to `production` on `memesh-api`. Frontend projects don't read it.
- `VITE_API_URL` — was previously `/api` for same-origin; the new frontends point at `https://api.memesh.co.il`.

---

## 1. Rename `memesh` → `memesh-staff`

You already changed Root Directory to `apps/staff` as a quick fix. Finish the rename so the project name reflects what it serves.

1. Vercel dashboard → `memesh` project → Settings → General.
2. Project Name → `memesh-staff` → Save.
3. Settings → Build and Deployment → confirm Root Directory is `apps/staff`.
4. Settings → Environment Variables → add **only one new variable** for the frontend:
   - `VITE_API_URL` = `https://api.memesh.co.il` (Production scope).
5. (Optional) Strip every old back-end env var off this project — they aren't read by the frontend and leaving them is noise. The four secrets that matter (`JWT_SECRET`, `SERVER_SECRET_KEY`, etc.) live on `memesh-api` from section 5 forward.
6. Don't deploy yet. Adding the domain in section 7 will trigger a redeploy.

---

## 2. Create `memesh-admin`

1. Vercel dashboard → Add New → Project → import `github.com/kritix-ops/memesh` (same repo, same branch).
2. Project Name → `memesh-admin`.
3. Build settings → Root Directory → **`apps/admin`**. Framework preset will auto-detect Vite.
4. Skip env vars for now — set them in step 6 of this section.
5. Click Deploy. First build will produce a preview URL like `memesh-admin-xxx.vercel.app`.
6. After the build, go to Settings → Environment Variables. Add:
   - `VITE_API_URL` = `https://api.memesh.co.il` (Production scope).
   - `VITE_STAFF_URL` = `https://staff.memesh.co.il` (Production scope). This is the link surfaced on the "no permission" screen for cashier-role users who land here.

---

## 3. Create `memesh-customer`

1. Same flow as `memesh-admin`.
2. Project Name → `memesh-customer`.
3. Root Directory → **`apps/customer`**.
4. Env vars:
   - `VITE_API_URL` = `https://api.memesh.co.il` (Production scope).

---

## 4. Create `memesh-api`

This is the only project that needs the full env. Do this slowly. Mistakes here are the production-accident class.

1. Vercel dashboard → Add New → Project → import the same repo.
2. Project Name → `memesh-api`.
3. Root Directory → **`apps/api-deploy`**. Framework preset → **Other** (it's a Fastify bundle, not a framework).
4. Skip env vars for now — adding them all in one paste is safer than mid-deploy.

### 4a. Set environment variables on `memesh-api`

Go to Settings → Environment Variables. All values are Production scope unless noted.

**Required (everything breaks without these):**

- `NODE_ENV` = `production`
- `DATABASE_URL` = (from your scratch buffer)
- `SERVER_SECRET_KEY` = (from your scratch buffer, byte-identical)
- `JWT_SECRET` = (from your scratch buffer, byte-identical)
- `QR_KEY_ID` = (from your scratch buffer, byte-identical)
- `JWT_ISSUER` = `memesh` (or whatever the old project had)
- `JWT_AUDIENCE` = `memesh-api` (or whatever the old project had)
- `JWT_CUSTOMER_AUDIENCE` = `memesh-customer` (or whatever the old project had)

**New for the split topology (do not copy from the old project — these are net-new):**

- `CORS_ALLOWED_ORIGINS` = `https://staff.memesh.co.il,https://admin.memesh.co.il,https://my.memesh.co.il`
  No spaces. No trailing slashes. No wildcard.
- `COOKIE_DOMAIN` = `.memesh.co.il`
  Leading dot is intentional — it tells the browser to send the cookie to every subdomain of memesh.co.il.

**Copy if set on the old project (skip otherwise — defaults are safe):**

- `LOG_LEVEL` = `info`
- SMS: `SMS_PROVIDER`, `PULSEEM_API_KEY`, `PULSEEM_FROM_NUMBER`, `PULSEEM_BASE_URL`
- Email: `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`
- WordPress sync: `WP_BASE_URL`, `WP_SYNC_USER`, `WP_SYNC_APP_PASSWORD`
- WooCommerce: `WC_WEBHOOK_SECRET`, `CRON_SECRET`, `WC_API_URL`, `WC_API_CONSUMER_KEY`, `WC_API_CONSUMER_SECRET`, `WC_RECONCILE_LOOKBACK_HOURS`

### 4b. Redeploy `memesh-api`

Trigger a redeploy from the dashboard after env vars are set. First build will run `pnpm db:migrate` (the buildCommand checks `VERCEL_ENV=production`). The build also produces the API bundle at `apps/api-deploy/lib/api-bundle.mjs`.

Watch the build logs for:
- `[build api] entry .../apps/api/src/app.ts`
- `[build api] outfile .../apps/api-deploy/lib/api-bundle.mjs`
- Final size around 2.1 MB.

Once green, the preview URL (`memesh-api-xxx.vercel.app`) is the API. **Smoke-test on the preview URL before attaching `api.memesh.co.il`**:

```bash
# Health endpoint
curl -sI https://memesh-api-xxx.vercel.app/health
# Expect: HTTP/2 200 and X-Robots-Tag: noindex, nofollow

curl -s https://memesh-api-xxx.vercel.app/health
# Expect: {"status":"ok","env":"production","timestamp":"..."}
```

If `/health` returns 500, check the runtime logs panel — usually `DATABASE_URL` is wrong or `SERVER_SECRET_KEY` is shorter than 32 chars (zod rejects it at config-parse time).

---

## 5. Cloudflare DNS

Add four CNAME records. **All four DNS-only (gray cloud), not proxied.**

In Cloudflare dashboard → `memesh.co.il` zone → DNS → Records → Add record. For each row:

| Type  | Name    | Target                    | Proxy status | TTL  |
|-------|---------|---------------------------|--------------|------|
| CNAME | staff   | `cname.vercel-dns.com`    | **DNS only** | Auto |
| CNAME | admin   | `cname.vercel-dns.com`    | **DNS only** | Auto |
| CNAME | my      | `cname.vercel-dns.com`    | **DNS only** | Auto |
| CNAME | api     | `cname.vercel-dns.com`    | **DNS only** | Auto |

Do NOT change the apex `memesh.co.il` A or CNAME record. It stays pointing at WordPress.

Why DNS-only: Vercel terminates TLS directly. Cloudflare's orange-cloud proxy would add a layer of caching + cert handshakes that the current plan does not account for. You can flip individual records to proxied later if you want CF firewall / DDoS shaping on a specific subdomain.

---

## 6. Attach the four subdomains to the four projects

For each project, in Vercel dashboard → Settings → Domains → Add Domain:

| Vercel project       | Domain to add                  |
|----------------------|--------------------------------|
| memesh-staff         | `staff.memesh.co.il`           |
| memesh-admin         | `admin.memesh.co.il`           |
| memesh-customer      | `my.memesh.co.il`              |
| memesh-api           | `api.memesh.co.il`             |

After Add Domain on each project:
- Vercel checks the DNS. If the CNAME from section 5 has propagated, you'll see "Valid configuration". If not, wait 2–3 minutes and click "Refresh".
- Vercel automatically requests a Let's Encrypt certificate. This usually completes in under 2 minutes. The dashboard shows "Certificate issued" when done.
- Once the cert is issued, the production deployment on that project auto-promotes to the custom domain.

---

## 7. Update WooCommerce webhook (if it was set)

The WC webhook destination URL changes because `/api/*` no longer exists; it's just `/*` on `api.memesh.co.il`.

WordPress admin → WooCommerce → Settings → Advanced → Webhooks → edit the existing "Memesh" delivery (if present) → **Delivery URL**:

- Old: `https://memesh.co.il/api/webhooks/woocommerce/order` (or wherever it pointed)
- New: `https://api.memesh.co.il/webhooks/woocommerce/order`

Without this change, new WC orders stop creating Memesh cards via the live webhook. The hourly reconciliation cron will heal them on the next run, so this is recoverable, but try to update the webhook within the cutover window.

The WooCommerce signing secret (`WC_WEBHOOK_SECRET`) stays the same — both sides hash with it.

---

## 8. Verification — curl one-liners per subdomain

Run these after section 6 completes. Each subdomain should pass all three checks.

### Staff

```bash
# noindex header at the edge
curl -sI https://staff.memesh.co.il | grep -i x-robots-tag
# Expect: x-robots-tag: noindex, nofollow

# noindex meta in the HTML
curl -s https://staff.memesh.co.il | grep -i 'name="robots"'
# Expect: <meta name="robots" content="noindex, nofollow" />

# robots.txt
curl -s https://staff.memesh.co.il/robots.txt
# Expect:
# User-agent: *
# Disallow: /
```

### Admin

```bash
curl -sI https://admin.memesh.co.il | grep -i x-robots-tag
curl -s https://admin.memesh.co.il | grep -i 'name="robots"'
curl -s https://admin.memesh.co.il/robots.txt
```

### Customer

```bash
curl -sI https://my.memesh.co.il | grep -i x-robots-tag
curl -s https://my.memesh.co.il | grep -i 'name="robots"'
curl -s https://my.memesh.co.il/robots.txt
```

### API

```bash
# Health (also confirms env is parsed and DB is reachable)
curl -s https://api.memesh.co.il/health
# Expect: {"status":"ok","env":"production","timestamp":"..."}

# noindex header on every response
curl -sI https://api.memesh.co.il/health | grep -i x-robots-tag
# Expect: x-robots-tag: noindex, nofollow

# CORS allowlist accepts known origin
curl -sI -X OPTIONS https://api.memesh.co.il/auth/me \
  -H "Origin: https://staff.memesh.co.il" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control
# Expect:
# access-control-allow-origin: https://staff.memesh.co.il
# access-control-allow-credentials: true

# CORS allowlist rejects unknown origin
curl -sI -X OPTIONS https://api.memesh.co.il/auth/me \
  -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
# Expect: nothing (no Allow-Origin header)

# Allow-Origin is never the wildcard
curl -sI -X OPTIONS https://api.memesh.co.il/auth/me \
  -H "Origin: https://staff.memesh.co.il" \
  -H "Access-Control-Request-Method: GET" | grep -i 'allow-origin: \*'
# Expect: nothing
```

### Cookie domain (end-to-end)

Sign in as staff in a browser, then check DevTools → Application → Cookies → `https://staff.memesh.co.il`:

- `access_token` and `refresh_token` should both show `Domain: .memesh.co.il`.
- Navigate to `https://admin.memesh.co.il` in the same tab. DevTools should show the same two cookies. The admin app should hydrate as signed-in without a second login.

If you'd rather do it from the terminal:

```bash
# Replace PHONE and PASSWORD with a real staff account
curl -i -X POST https://api.memesh.co.il/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"PHONE","password":"PASSWORD"}'
# Expect, in the Set-Cookie headers:
#   access_token=...; Domain=.memesh.co.il; Path=/; HttpOnly; Secure; SameSite=Lax
#   refresh_token=...; Domain=.memesh.co.il; Path=/; HttpOnly; Secure; SameSite=Lax
```

### Cross-surface session leakage (must reject)

```bash
# Save just a staff cookie
curl -c /tmp/staff-cookies.txt -X POST https://api.memesh.co.il/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"PHONE","password":"PASSWORD"}'

# Customer route should NOT accept a staff cookie → 401
curl -i -b /tmp/staff-cookies.txt https://api.memesh.co.il/me/cards
# Expect: HTTP/2 401, body {"error":"unauthorized"}
rm /tmp/staff-cookies.txt
```

### Cron sanity

```bash
# Reconcile route returns 401 without the cron secret (good)
curl -i https://api.memesh.co.il/cron/wc-reconcile
# Expect: HTTP/2 401

# Returns 200 with the right secret (replace CRON_SECRET_VALUE)
curl -i https://api.memesh.co.il/cron/wc-reconcile \
  -H 'Authorization: Bearer CRON_SECRET_VALUE'
# Expect: HTTP/2 200, body with reconcile counts (or 503 if WC creds are absent)
```

Vercel auto-runs the cron once per hour from the `crons` entry in `apps/api-deploy/vercel.json`. After the first hour, check the project's "Cron Jobs" tab for the run log.

---

## 9. Cutover sequencing — read this before clicking anything

The order in section 1–6 matters. A safer micro-sequence inside section 6:

1. Attach `api.memesh.co.il` to `memesh-api` first.
2. Verify section 8's API checks pass.
3. Attach `staff.memesh.co.il` to `memesh-staff`.
4. Visit `https://staff.memesh.co.il` in a browser and sign in. Confirm DevTools shows `Domain=.memesh.co.il` on the auth cookies.
5. Attach `admin.memesh.co.il` and confirm SSO from step 4.
6. Attach `my.memesh.co.il` last.

Reason: the frontends point at `api.memesh.co.il` via `VITE_API_URL` baked into their build. If the API origin isn't up first, the frontends fail every request. Bringing the API up first is a 30-second extra step that avoids a confusing "everything is broken" window.

---

## 10. Rollback procedure

By severity, low to high.

### A. One frontend deploy is broken

Symptom: section 8's checks fail for staff/admin/customer but the API is healthy.

1. Vercel dashboard → broken project → Deployments tab.
2. Find the last green deployment (sorted by date).
3. Click the three-dot menu → "Promote to Production".
4. That deployment becomes the live one on the custom domain. Takes ~30 seconds.
5. Investigate the broken build in the Vercel logs without rushing.

### B. The API is broken

Symptom: `/health` returns 500 or 503, or every frontend shows network errors.

1. Vercel dashboard → `memesh-api` → Deployments → last green deploy → Promote to Production.
2. If there's no prior green deploy on this project (this is your first cutover), the rollback is to remove the custom domain from `memesh-api` and re-point the frontends back at whatever was previously serving the API. Since apps/web is gone, this means reverting Phase 5 on the branch (`git revert 54d3475`) and redeploying.
3. Practical lesson: section 4b's smoke-test on the preview URL is non-negotiable. **Do not attach `api.memesh.co.il` until the preview URL passes `/health`.**

### C. Cookies stopped working for everyone

Symptom: customers and staff get force-logged-out and re-login fails. DevTools shows duplicate cookies, or cookies missing entirely.

Most likely cause: `COOKIE_DOMAIN` was wrong (e.g., `memesh.co.il` without the leading dot, or `.memesh.com.il`).

1. Vercel dashboard → `memesh-api` → Settings → Environment Variables → `COOKIE_DOMAIN` → delete the variable.
2. Trigger a redeploy on `memesh-api`.
3. Within ~1 minute the API is back to origin-scoped cookies. Frontends still work but SSO between staff and admin requires a second login. That's a paper cut; this is recovery, not the final state.
4. Fix the value (`.memesh.co.il`), re-add the env var, redeploy.
5. After the value is corrected, instruct any user who got duplicate cookies to clear cookies for `*.memesh.co.il` once and log back in.

### D. Database migration ran something destructive

Symptom: `/health` returns 500 with a DB error after the first prod deploy of `memesh-api`.

The buildCommand on `memesh-api` runs `pnpm db:migrate` in production. If a migration failed mid-way or applied something unintended:

1. **Stop further deploys.** Vercel dashboard → `memesh-api` → Settings → Git → "Production Branch" → temporarily switch to a non-existent branch name (e.g., `frozen`) so auto-deploys halt.
2. Restore from Neon point-in-time recovery. Neon dashboard → branch the affected branch back to a known-good timestamp from before the cutover.
3. Investigate the migration. Fix it on a branch, deploy to a preview URL, confirm health, then promote.

You should have a Neon point-in-time mark taken BEFORE starting Phase 6. If you haven't, take one now via Neon dashboard → Branches → "Create branch from this point" before continuing.

### E. Cloudflare DNS misroute

Symptom: a subdomain shows the wrong project (e.g., `api.memesh.co.il` shows the staff login form).

Cause: a CNAME record points at the wrong target, OR a Vercel project has the wrong domain attached.

1. Vercel dashboard → each of the four projects → Settings → Domains. Confirm each project has only its intended domain.
2. Cloudflare dashboard → DNS. Confirm all four CNAMEs target `cname.vercel-dns.com` (not each other).
3. Worst case: remove the offending CNAME, wait for negative cache (1–5 min on Cloudflare DNS-only), re-add.

---

## 11. Cleanup after cutover succeeds

After all eight verification curls pass and you've logged in as staff + admin + customer successfully:

- Remove old back-end env vars from `memesh-staff` (the renamed frontend). They were inherited from the original `memesh` project and serve no purpose on a Vite frontend; leaving them is an unnecessary disclosure of secrets to whoever has dashboard access.
- Update `memesh-brief-v3.md` to reflect the new topology (per Phase 7 acceptance criteria in the original plan).
- Remove this runbook from `_plans/` once Phase 6 is done if you want — or keep it as a reference for the next time a deploy topology changes.

---

## Quick reference card

For pinning to a sticky note during cutover.

```
Vercel projects (4):
  memesh-staff     → apps/staff      → staff.memesh.co.il
  memesh-admin     → apps/admin      → admin.memesh.co.il
  memesh-customer  → apps/customer   → my.memesh.co.il
  memesh-api       → apps/api-deploy → api.memesh.co.il

Cloudflare CNAMEs (4, all DNS-only / gray cloud):
  staff  → cname.vercel-dns.com
  admin  → cname.vercel-dns.com
  my     → cname.vercel-dns.com
  api    → cname.vercel-dns.com

Must-match secrets between old `memesh` project and new `memesh-api`:
  SERVER_SECRET_KEY   ← break = cards unusable + OTP broken
  JWT_SECRET          ← break = staff force-logout
  QR_KEY_ID           ← break = existing cards' keyId doesn't match
  DATABASE_URL        ← obvious

Net-new env vars on memesh-api:
  CORS_ALLOWED_ORIGINS = https://staff.memesh.co.il,https://admin.memesh.co.il,https://my.memesh.co.il
  COOKIE_DOMAIN        = .memesh.co.il    (LEADING DOT)
  NODE_ENV             = production

Frontend env vars:
  memesh-staff:    VITE_API_URL=https://api.memesh.co.il
  memesh-admin:    VITE_API_URL=https://api.memesh.co.il
                   VITE_STAFF_URL=https://staff.memesh.co.il
  memesh-customer: VITE_API_URL=https://api.memesh.co.il

Attach domains in this order:
  1. api.memesh.co.il  (so frontends have a working backend)
  2. staff.memesh.co.il
  3. admin.memesh.co.il
  4. my.memesh.co.il

WooCommerce webhook URL (if used):
  was: .../api/webhooks/woocommerce/order
  now: https://api.memesh.co.il/webhooks/woocommerce/order
```
