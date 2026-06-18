# scripts/cloudways

Production deployment kit for the Memesh API on a Cloudways box (or any
Docker host). Full runbook lives in
[`_plans/2026-06-18-cloudways-deployment-kit.md`](../../_plans/2026-06-18-cloudways-deployment-kit.md).

Each script is idempotent where it can be and verbose about what it's doing.

| Script                | When to run                                             |
| --------------------- | ------------------------------------------------------- |
| `generate-secrets.sh` | Once per box (creates `.env` with random secrets).      |
| `bootstrap.sh`        | Once per box (first-time setup; prompts for the admin). |
| `deploy.sh`           | Every code release (pull + rebuild + restart).          |
| `pg-backup.sh`        | Nightly via cron — see `pg-backup.cron` template.       |
| `healthcheck.sh`      | Every few minutes via cron / external uptime monitor.   |

## Quick start

```bash
# On a fresh Cloudways box:
ssh memesh-cloudways
git clone https://github.com/kritix-ops/memesh.git
cd memesh
bash scripts/cloudways/bootstrap.sh    # interactive
# Verify in a browser at https://$DOMAIN
```

Subsequent releases:

```bash
ssh memesh-cloudways
cd memesh
bash scripts/cloudways/deploy.sh
```

## Backup schedule

```bash
sudo cp scripts/cloudways/pg-backup.cron /etc/cron.d/memesh-backup
sudo systemctl restart cron
# First dump lands at 02:30 server time; verify next day with:
ls -lh /var/backups/memesh/
```

Run the backup-restore drill at least once before going live (see runbook
§11.5).

## What's NOT in this kit

- CI/CD pipeline (the deploy script is one ssh call away from being CI-callable).
- Off-box backup destination (Yanai picks a target — Backblaze B2 EU, S3
  Frankfurt, or DO Spaces — and we add one rclone/aws line to `pg-backup.sh`).
- Cloudflare-in-front config (Yanai already runs WordPress through Cloudflare;
  point an additional record at this box and turn on Cloudflare's proxy).
- A staging environment (single-server, single-env for Phase 1).
