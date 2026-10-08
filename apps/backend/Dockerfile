# syntax=docker/dockerfile:1.7
# Backend API image. Build from the repo root so the shared workspace is in context:
#   docker build -f apps/backend/Dockerfile -t emptrack-backend .
#
# Targets:
#   build   - full toolchain (prisma CLI, ts-node-dev). Used by the compose
#             `migrate` service to apply the schema and run the seed.
#   runtime - slim production image (default).

ARG NODE_VERSION=20

# ---------- deps: all workspace deps needed by backend + shared ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w packages/shared -w apps/backend --include-workspace-root

# ---------- build: compile shared + backend, generate Prisma client ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run build -w packages/shared \
 && npm run build -w apps/backend
# Applies migrations when present, otherwise pushes the schema (fresh scaffold
# has no migrations yet). Optional seed with SEED=true.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'cd /app/apps/backend' \
  'if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then' \
  '  npx prisma migrate deploy' \
  'else' \
  '  echo "[migrate] no migrations found, running prisma db push"' \
  '  npx prisma db push --skip-generate' \
  'fi' \
  'if [ "$SEED" = "true" ]; then npm run seed; fi' \
  > /usr/local/bin/migrate && chmod +x /usr/local/bin/migrate
CMD ["migrate"]

# ---------- prod-deps: production-only node_modules ----------
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w packages/shared -w apps/backend --include-workspace-root --ignore-scripts --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    BACKEND_PORT=4000
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# Generated Prisma client (engine + types) from the build stage.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --from=build --chown=node:node /app/apps/backend/prisma ./apps/backend/prisma
USER node
WORKDIR /app/apps/backend
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BACKEND_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
