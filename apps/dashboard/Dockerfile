# syntax=docker/dockerfile:1.7
# Dashboard image (Next.js standalone output). Build from the repo root:
#   docker build -f apps/dashboard/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t emptrack-dashboard .
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so the
# API URL must be passed as a build arg, not a runtime env var.

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w apps/dashboard --include-workspace-root

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4002
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
