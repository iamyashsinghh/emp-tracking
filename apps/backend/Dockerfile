# Backend image. Built from the repo root so the shared workspace is available.
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install deps using the workspace manifests.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN npm install

# Build shared then backend.
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run build -w packages/shared \
 && npm run build -w apps/backend

EXPOSE 4000
# migrate deploy then start. For first run, seed manually: npm run seed -w apps/backend
CMD ["sh", "-c", "npm run prisma:deploy -w apps/backend && npm run start -w apps/backend"]
