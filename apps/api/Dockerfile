# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @memesh/api. The build stage installs the full workspace
# and uses `pnpm deploy` to produce a self-contained, tree-shaken /prod/api/
# tree containing only what the api needs at runtime. The runtime stage copies
# that tree into a small Node 24 image and runs `tsx src/server.ts` directly —
# workspace packages stay as TypeScript source (no package-level build step).

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
# Corepack ships with Node 24. Pin the exact pnpm version from the root package.json.
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# --- build stage: install the full workspace, deploy a prod-only api bundle ----
FROM base AS build
WORKDIR /usr/src/app
COPY . .
# BuildKit cache mount keeps the pnpm store across image rebuilds.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# `pnpm deploy --prod` strips devDependencies and inlines workspace deps under
# node_modules/, so the runtime image has zero ties back to the monorepo.
RUN pnpm deploy --filter=@memesh/api --prod /prod/api

# --- runtime stage: minimal image that just runs the api ----------------------
FROM base AS runtime
WORKDIR /prod/api
# node:24-slim ships a `node` user (uid 1000). Run as non-root.
COPY --from=build --chown=node:node /prod/api /prod/api
USER node
ENV NODE_ENV=production
EXPOSE 3001
# `pnpm start` -> `tsx src/server.ts`. Migrations are NOT run on boot — operators
# run `pnpm seed:admin` (which runs migrations + creates the first admin) once
# at deploy time. See _plans/2026-06-18-api-deployment-kit.md §2.5.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
